-- Where a city's traffic-signal controller plugs in.
--
-- The green corridor's junction states have always been simulated: SUTRA has
-- no authority over traffic lights, and in India that authority sits with the
-- city's adaptive signal control and the traffic police. This does not change
-- that. It records, for every junction on a corridor, the request SUTRA would
-- make of the city - pre-empt this junction, hold it green, release it - so
-- an authority can see exactly what integration would ask of them, and
-- connects those requests to a documented interface (docs/signal-adapter.md)
-- that is off until an authority turns it on.
--
-- Two rules shape it:
--
--   * SUTRA requests; the city decides. A command is a request the city's
--     controller may refuse, and its answer is recorded either way.
--   * A junction is never left held. When a corridor ends - on arrival, by the
--     driver, or by expiry - every junction not yet released gets a RELEASE.

create table public.signal_commands (
  id            bigint generated always as identity primary key,
  corridor_id   uuid not null references public.corridors (id) on delete cascade,
  signal_id     bigint references public.corridor_signals (id) on delete cascade,
  osm_id        bigint,
  lat           double precision,
  lng           double precision,
  command       text not null check (command in ('PREEMPT', 'HOLD_GREEN', 'RELEASE')),
  -- Seconds until the vehicle reaches the junction, as estimated when issued.
  eta_s         integer,
  -- The way the emergency vehicle is heading, so the controller knows which
  -- approach to give green.
  approach_deg  real,
  vehicle_type  text,
  issued_at     timestamptz not null default now(),
  adapter       text not null check (adapter in ('simulation', 'http')),
  status        text not null check (status in (
                  'SIMULATED',      -- simulation mode: recorded, never sent
                  'QUEUED',         -- waiting to be sent to the city
                  'SENT',           -- handed to the city, no answer yet
                  'ACKNOWLEDGED',   -- the city accepted it
                  'REJECTED',       -- the city refused it, and said why
                  'FAILED'          -- could not be delivered
                )),
  response      jsonb,
  responded_at  timestamptz
);

create index signal_commands_corridor_idx on public.signal_commands (corridor_id, issued_at);

alter table public.signal_commands enable row level security;

-- Whoever can see the corridor can see what was asked on its behalf.
create policy signal_commands_select on public.signal_commands
  for select to authenticated using (public.can_see_corridor(corridor_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.signal_commands;
  end if;
end
$$;

-- 'simulation' records commands and sends nothing. 'http' sends them to the
-- city's adapter, configured on the signal-dispatch function.
insert into public.settings (key, value) values ('signal_adapter_mode', '"simulation"')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Issuing a command.
-- ---------------------------------------------------------------------------

create or replace function public.issue_signal_command(
  p_signal  public.corridor_signals,
  p_command text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  mode     text := coalesce(
               (select value #>> '{}' from public.settings where key = 'signal_adapter_mode'),
               'simulation');
  veh      record;
  eta      integer;
  new_id   bigint;
  base_url text;
  api_key  text;
begin
  select p.lat, p.lng, p.speed, p.heading, v.vehicle_type into veh
    from public.corridors c
    join public.vehicles v on v.id = c.vehicle_id
    left join public.vehicle_positions p on p.vehicle_id = c.vehicle_id
   where c.id = p_signal.corridor_id;

  if p_command = 'PREEMPT' and veh.speed is not null and veh.speed > 1 then
    eta := round(public.approx_distance_m(veh.lat, veh.lng, p_signal.lat, p_signal.lng) / (veh.speed / 3.6));
  end if;

  insert into public.signal_commands
    (corridor_id, signal_id, osm_id, lat, lng, command, eta_s, approach_deg, vehicle_type, adapter, status)
  values
    (p_signal.corridor_id, p_signal.id, p_signal.osm_id, p_signal.lat, p_signal.lng, p_command, eta,
     veh.heading, veh.vehicle_type,
     case when mode = 'http' then 'http' else 'simulation' end,
     case when mode = 'http' then 'QUEUED' else 'SIMULATED' end)
  returning id into new_id;

  -- Only an authority that has connected a controller sends anything.
  if mode <> 'http' then
    return;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return;
  end if;

  execute $q$
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'sutra_project_url'),
      (select decrypted_secret from vault.decrypted_secrets where name = 'sutra_push_key')
  $q$ into base_url, api_key;
  if base_url is null or api_key is null then
    return;
  end if;

  execute $q$
    select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)
  $q$
  using
    base_url || '/functions/v1/signal-dispatch',
    jsonb_build_object('command_id', new_id),
    jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || api_key);
end;
$$;

/** A junction changed state: say so to the city, in its terms. */
create or replace function public.signal_state_command()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = old.state then
    return new;
  end if;

  if new.state = 'PREEMPT' then
    perform public.issue_signal_command(new, 'PREEMPT');
  elsif new.state = 'GREEN' then
    perform public.issue_signal_command(new, 'HOLD_GREEN');
  elsif new.state = 'PASSED' and old.state in ('PREEMPT', 'GREEN') then
    perform public.issue_signal_command(new, 'RELEASE');
  end if;
  return new;
exception when others then
  -- This runs inside the ambulance's own position update.
  raise warning 'signal command failed for signal %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger corridor_signals_command
  after update of state on public.corridor_signals
  for each row execute function public.signal_state_command();

/**
 * A corridor ended. Any junction that was asked to pre-empt or hold green and
 * has not been released yet is released now - whether the ambulance arrived,
 * the driver stopped the corridor, or it expired.
 */
create or replace function public.release_signals_on_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.corridor_signals;
begin
  if new.status <> 'ENDED' or old.status = 'ENDED' then
    return new;
  end if;

  for s in
    select * from public.corridor_signals cs
     where cs.corridor_id = new.id and cs.state in ('PREEMPT', 'GREEN')
  loop
    perform public.issue_signal_command(s, 'RELEASE');
  end loop;
  return new;
exception when others then
  raise warning 'releasing signals failed for corridor %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger corridors_release_signals
  after update of status on public.corridors
  for each row execute function public.release_signals_on_end();

-- ---------------------------------------------------------------------------
-- For the dispatch function: claim a queued command, record the answer.
-- ---------------------------------------------------------------------------

create or replace function public.claim_signal_command(p_command_id bigint)
returns setof public.signal_commands
language sql
security definer
set search_path = ''
as $$
  update public.signal_commands
     set status = 'SENT'
   where id = p_command_id and status = 'QUEUED'
  returning *;
$$;

create or replace function public.record_signal_response(
  p_command_id bigint,
  p_status     text,
  p_response   jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  update public.signal_commands
     set status = case when p_status in ('ACKNOWLEDGED', 'REJECTED', 'FAILED') then p_status else 'FAILED' end,
         response = p_response,
         responded_at = now()
   where id = p_command_id and status = 'SENT';
$$;

-- Internal, or server-only.
revoke execute on function public.issue_signal_command(public.corridor_signals, text) from public, anon, authenticated;
revoke execute on function public.signal_state_command() from public, anon, authenticated;
revoke execute on function public.release_signals_on_end() from public, anon, authenticated;
revoke execute on function public.claim_signal_command(bigint) from public, anon, authenticated;
revoke execute on function public.record_signal_response(bigint, text, jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_signal_command(bigint) to service_role;
    grant execute on function public.record_signal_response(bigint, text, jsonb) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Corridors that end without anyone ending them.
-- ---------------------------------------------------------------------------

-- Found while writing the release rule above: nothing ever marked an expired
-- corridor ENDED. Arrival, the driver and a new corridor all did; but if the
-- ambulance's phone died mid-run the corridor stayed ACTIVE indefinitely, its
-- junctions were never released, and the nightly prune (which only removes
-- ENDED corridors) never removed it.
--
-- Ended here, either way it lapses: an hour after it started, or two minutes
-- after its vehicle stopped reporting. A junction should not stay held because
-- a phone ran out of battery.
create or replace function public.end_stale_corridors()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.corridors c
     set status = 'ENDED', ended_at = now()
   where c.status = 'ACTIVE'
     and (
       c.expires_at <= now()
       or not exists (
         select 1 from public.vehicle_positions p
          where p.vehicle_id = c.vehicle_id
            and p.updated_at > now() - interval '2 minutes'
       )
     )
     -- A corridor opened a moment ago may not have its first position yet.
     and c.started_at < now() - interval '2 minutes';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.end_stale_corridors() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('sutra-end-stale-corridors', '* * * * *', 'select public.end_stale_corridors()');
  end if;
exception when others then
  raise notice 'pg_cron unavailable, skipping schedule: %', sqlerrm;
end
$$;
