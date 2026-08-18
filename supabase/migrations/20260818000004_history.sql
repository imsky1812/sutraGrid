-- Drive history and violations.
--
-- vehicle_positions holds one upserted row per vehicle, so it has no memory:
-- each update overwrites the last. Anything asking "where was this vehicle on
-- Tuesday" needs an append-only record, which is what this adds.
--
-- Both tables are written by triggers on vehicle_positions rather than by the
-- app. The client keeps its single upsert, and history cannot be skipped by a
-- modified client - the same reasoning as the emergency-escalation trigger.

create table public.position_history (
  id          bigint generated always as identity primary key,
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  lat         double precision not null,
  lng         double precision not null,
  speed       real not null,
  heading     real not null,
  recorded_at timestamptz not null default now()
);

create index position_history_vehicle_time_idx
  on public.position_history (vehicle_id, recorded_at desc);

create table public.violations (
  id          bigint generated always as identity primary key,
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  kind        text not null default 'SPEEDING' check (kind in ('SPEEDING')),
  speed       real not null,
  speed_limit real not null,
  lat         double precision not null,
  lng         double precision not null,
  occurred_at timestamptz not null default now(),
  cleared_at  timestamptz
);

create index violations_vehicle_time_idx
  on public.violations (vehicle_id, occurred_at desc);

alter table public.position_history enable row level security;
alter table public.violations enable row level security;

-- Drivers read their own; operators read everything. Nobody writes directly:
-- there are no insert policies, so rows can only arrive via the triggers below,
-- which run as definer.
create policy history_select_own on public.position_history
  for select to authenticated using (
    exists (select 1 from public.vehicles v
             where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

create policy history_select_operator on public.position_history
  for select to authenticated using (public.is_operator());

create policy violations_select_own on public.violations
  for select to authenticated using (
    exists (select 1 from public.vehicles v
             where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

create policy violations_select_operator on public.violations
  for select to authenticated using (public.is_operator());

-- The speed limit is one number in one place. Both the trigger and any client
-- that wants to display it read from here.
create table public.settings (
  key   text primary key,
  value jsonb not null
);

insert into public.settings (key, value) values ('speed_limit_kmh', '80'::jsonb);

alter table public.settings enable row level security;
create policy settings_read_all on public.settings
  for select to authenticated using (true);

create or replace function public.speed_limit_kmh()
returns real language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::real from public.settings where key = 'speed_limit_kmh'), 80)
$$;

grant execute on function public.speed_limit_kmh() to authenticated;

-- Append every accepted position to history.
create or replace function public.record_position_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
  values (new.vehicle_id, new.lat, new.lng, new.speed, new.heading, coalesce(new.updated_at, now()));
  return new;
end;
$$;

create trigger vehicle_positions_history
  after insert or update on public.vehicle_positions
  for each row execute function public.record_position_history();

-- Open a violation when a vehicle crosses the limit, close it when it drops
-- clear. Recording an episode rather than a row per frame is what keeps a
-- vehicle speeding for a minute from producing sixty violations.
create or replace function public.record_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  limit_kmh real := public.speed_limit_kmh();
  open_id   bigint;
begin
  select id into open_id
    from public.violations
   where vehicle_id = new.vehicle_id and cleared_at is null
   order by occurred_at desc limit 1;

  if new.speed > limit_kmh then
    if open_id is null then
      insert into public.violations (vehicle_id, speed, speed_limit, lat, lng)
      values (new.vehicle_id, new.speed, limit_kmh, new.lat, new.lng);
    else
      -- Keep the worst speed seen during the episode.
      update public.violations set speed = greatest(speed, new.speed) where id = open_id;
    end if;
  elsif open_id is not null and new.speed < limit_kmh - 5 then
    -- Hysteresis: hovering at the limit must not open and close repeatedly.
    update public.violations set cleared_at = now() where id = open_id;
  end if;

  return new;
end;
$$;

create trigger vehicle_positions_violations
  after insert or update on public.vehicle_positions
  for each row execute function public.record_speed_violation();
