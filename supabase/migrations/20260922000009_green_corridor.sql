-- Green corridor.
--
-- An authorized emergency vehicle declares where it is going. On every
-- position it reports, the database warns the SUTRA drivers ahead of it on its
-- route, and advances a simulated state for the real junctions along the way.
--
-- What is real and what is not matters here, because this is shown to traffic
-- authorities. The route and the warnings to drivers are real. The signal
-- states are a SIMULATION: nothing here talks to a traffic controller. They
-- show what an integration with a city's signal system would do, and every
-- client labels them that way.
--
-- See docs/superpowers/specs/2026-09-22-green-corridor-design.md.

-- Planar approximation, accurate to well under a metre over the few kilometres
-- a corridor spans, and far cheaper than haversine in a per-frame trigger.
create or replace function public.approx_distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select sqrt(
    power((lat2 - lat1) * 110540, 2) +
    power((lng2 - lng1) * 111320 * cos(radians((lat1 + lat2) / 2)), 2)
  )
$$;

create table public.corridors (
  id               uuid primary key default gen_random_uuid(),
  vehicle_id       uuid not null references public.vehicles (id) on delete cascade,
  destination_lat  double precision not null check (destination_lat between -90 and 90),
  destination_lng  double precision not null check (destination_lng between -180 and 180),
  destination_name text check (char_length(destination_name) <= 120),
  distance_m       real,
  duration_s       real,
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'ENDED')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  expires_at       timestamptz not null default now() + interval '1 hour'
);

-- The trigger looks up a vehicle's live corridor on every frame.
create index corridors_active_idx on public.corridors (vehicle_id) where status = 'ACTIVE';

create table public.corridor_route_points (
  corridor_id uuid not null references public.corridors (id) on delete cascade,
  seq         integer not null,
  lat         double precision not null,
  lng         double precision not null,
  -- Distance from the start of the route, so "ahead of the vehicle" is a
  -- comparison of two numbers.
  along_m     double precision not null,
  primary key (corridor_id, seq)
);

create index corridor_route_points_along_idx on public.corridor_route_points (corridor_id, along_m);

create table public.corridor_signals (
  id          bigint generated always as identity primary key,
  corridor_id uuid not null references public.corridors (id) on delete cascade,
  seq         integer not null,
  osm_id      bigint,
  lat         double precision not null,
  lng         double precision not null,
  along_m     double precision not null,
  -- SIMULATED. See the header.
  state       text not null default 'WAITING'
                check (state in ('WAITING', 'PREEMPT', 'GREEN', 'PASSED')),
  updated_at  timestamptz not null default now()
);

create index corridor_signals_corridor_idx on public.corridor_signals (corridor_id, seq);

-- One warning per vehicle per corridor. A beep every second would be noise,
-- and noise is what drivers learn to ignore.
create table public.corridor_warnings (
  corridor_id uuid not null references public.corridors (id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  warned_at   timestamptz not null default now(),
  primary key (corridor_id, vehicle_id)
);

-- ---------------------------------------------------------------------------
-- Access. There are deliberately no client write policies: corridors are
-- created and ended only through the functions below, and signals only ever
-- change in the trigger.

alter table public.corridors enable row level security;
alter table public.corridor_route_points enable row level security;
alter table public.corridor_signals enable row level security;
alter table public.corridor_warnings enable row level security;

create or replace function public.can_see_corridor(p_corridor_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.is_operator() or exists (
    select 1 from public.corridors c
      join public.vehicles v on v.id = c.vehicle_id
     where c.id = p_corridor_id and v.owner = (select auth.uid())
  )
$$;

create policy corridors_select on public.corridors
  for select to authenticated using (public.can_see_corridor(id));

create policy corridor_route_points_select on public.corridor_route_points
  for select to authenticated using (public.can_see_corridor(corridor_id));

create policy corridor_signals_select on public.corridor_signals
  for select to authenticated using (public.can_see_corridor(corridor_id));

create policy corridor_warnings_select on public.corridor_warnings
  for select to authenticated using (
    public.is_operator()
    or exists (select 1 from public.vehicles v
                where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Alerts gain a category for "give way".

alter table public.alerts drop constraint alerts_category_check;
alter table public.alerts add constraint alerts_category_check
  check (category in ('CONGESTION', 'RULE', 'HAZARD', 'MESSAGE', 'EMERGENCY'));

-- ---------------------------------------------------------------------------
-- Starting and ending.

create or replace function public.start_corridor(
  p_vehicle_id       uuid,
  p_destination_name text,
  p_route            jsonb,
  p_signals          jsonb default '[]'::jsonb,
  p_distance_m       real default null,
  p_duration_s       real default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_id uuid;
  n_points integer := coalesce(jsonb_array_length(p_route), 0);
  last_point jsonb;
begin
  -- Ownership and the operator-granted flag are both required. The flag is the
  -- whole authorization: drivers cannot set it on their own vehicles.
  if not exists (
    select 1 from public.vehicles
     where id = p_vehicle_id
       and owner = (select auth.uid())
       and is_emergency_authorized
  ) then
    raise exception 'This vehicle is not authorized to open a green corridor.'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_route) is distinct from 'array' or n_points < 2 or n_points > 5000 then
    raise exception 'A corridor route needs between 2 and 5000 points.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_signals) is distinct from 'array' or jsonb_array_length(p_signals) > 200 then
    raise exception 'Too many signals for one corridor.' using errcode = '22023';
  end if;

  -- One corridor per vehicle at a time.
  update public.corridors
     set status = 'ENDED', ended_at = now()
   where vehicle_id = p_vehicle_id and status = 'ACTIVE';

  last_point := p_route -> (n_points - 1);

  insert into public.corridors (vehicle_id, destination_lat, destination_lng, destination_name,
                                distance_m, duration_s)
  values (p_vehicle_id, (last_point ->> 0)::double precision, (last_point ->> 1)::double precision,
          left(p_destination_name, 120), p_distance_m, p_duration_s)
  returning id into new_id;

  insert into public.corridor_route_points (corridor_id, seq, lat, lng, along_m)
  select new_id, seq, lat, lng,
         coalesce(sum(step) over (order by seq), 0)
    from (
      select seq, lat, lng,
             coalesce(public.approx_distance_m(
               lag(lat) over (order by seq), lag(lng) over (order by seq), lat, lng), 0) as step
        from (
          select (ord - 1)::integer as seq,
                 (pt ->> 0)::double precision as lat,
                 (pt ->> 1)::double precision as lng
            from jsonb_array_elements(p_route) with ordinality as r (pt, ord)
        ) raw
    ) steps;

  -- Each junction sits at the distance of its nearest route point, and is
  -- numbered in the order the vehicle will reach it, whatever order it came in.
  insert into public.corridor_signals (corridor_id, seq, osm_id, lat, lng, along_m)
  select new_id, (row_number() over (order by placed.along_m))::integer, placed.osm_id,
         placed.lat, placed.lng, placed.along_m
    from (
      select (s ->> 'osm_id')::bigint as osm_id,
             (s ->> 'lat')::double precision as lat,
             (s ->> 'lng')::double precision as lng,
             (select p.along_m from public.corridor_route_points p
               where p.corridor_id = new_id
               order by public.approx_distance_m(p.lat, p.lng,
                          (s ->> 'lat')::double precision, (s ->> 'lng')::double precision)
               limit 1) as along_m
        from jsonb_array_elements(p_signals) as s
    ) placed;

  return new_id;
end;
$$;

create or replace function public.end_corridor(p_corridor_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.corridors c
      join public.vehicles v on v.id = c.vehicle_id
     where c.id = p_corridor_id and v.owner = (select auth.uid())
  ) then
    raise exception 'Not authorized to end this corridor.' using errcode = '42501';
  end if;

  update public.corridors
     set status = 'ENDED', ended_at = now()
   where id = p_corridor_id and status = 'ACTIVE';
end;
$$;

revoke execute on function public.start_corridor(uuid, text, jsonb, jsonb, real, real) from public, anon;
revoke execute on function public.end_corridor(uuid) from public, anon;
grant execute on function public.start_corridor(uuid, text, jsonb, jsonb, real, real) to authenticated;
grant execute on function public.end_corridor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The per-frame work.

create or replace function public.advance_corridor()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  c        record;
  progress double precision;
begin
  select id, destination_lat, destination_lng into c
    from public.corridors
   where vehicle_id = new.vehicle_id and status = 'ACTIVE' and expires_at > now()
   limit 1;

  -- The overwhelmingly common case: an ordinary vehicle, nothing to do.
  if not found then
    return new;
  end if;

  -- Progress is the nearest route point. Good enough on a road network, where
  -- the route does not double back on itself within a GPS error.
  select p.along_m into progress
    from public.corridor_route_points p
   where p.corridor_id = c.id
   order by public.approx_distance_m(p.lat, p.lng, new.lat, new.lng)
   limit 1;

  -- SIMULATED signal pre-emption. Only changed rows are written, so Realtime
  -- carries a transition rather than a stream of identical updates.
  update public.corridor_signals s
     set state = next.state, updated_at = now()
    from (
      select id,
             case
               when state = 'PASSED' or along_m - progress < -30 then 'PASSED'
               when along_m - progress <= 200 then 'GREEN'
               when along_m - progress <= 500 then 'PREEMPT'
               else 'WAITING'
             end as state
        from public.corridor_signals
       where corridor_id = c.id
    ) next
   where s.id = next.id and s.state <> next.state;

  -- Warn every other vehicle on the route ahead: within 150 m of it, in the
  -- next 1.5 km, and heard from recently enough that its position means
  -- something.
  with warned as (
    insert into public.corridor_warnings (corridor_id, vehicle_id)
    select c.id, vp.vehicle_id
      from public.vehicle_positions vp
     where vp.vehicle_id <> new.vehicle_id
       and vp.updated_at > now() - interval '2 minutes'
       and exists (
         select 1 from public.corridor_route_points p
          where p.corridor_id = c.id
            and p.along_m between progress and progress + 1500
            and public.approx_distance_m(p.lat, p.lng, vp.lat, vp.lng) <= 150
       )
    on conflict do nothing
    returning vehicle_id
  )
  insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
  select null, w.vehicle_id, 'EMERGENCY', 'CRITICAL',
         format('Emergency vehicle %s is approaching on your road. Keep left and give way.',
                v.vehicle_number),
         now() + interval '5 minutes'
    from warned w
    cross join (select vehicle_number from public.vehicles where id = new.vehicle_id) v;

  if public.approx_distance_m(new.lat, new.lng, c.destination_lat, c.destination_lng) <= 50 then
    update public.corridors set status = 'ENDED', ended_at = now() where id = c.id;
  end if;

  return new;
end;
$$;

create trigger vehicle_positions_corridor
  after insert or update on public.vehicle_positions
  for each row execute function public.advance_corridor();

-- An ambulance on a call is expected to exceed the limit. The violation is
-- still recorded; only the beep at the medic is suppressed.
create or replace function public.alert_on_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.corridors
     where vehicle_id = new.vehicle_id and status = 'ACTIVE' and expires_at > now()
  ) then
    return new;
  end if;

  insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
  values (
    null,
    new.vehicle_id,
    'RULE',
    'WARNING',
    format('Overspeeding: %s km/h in a %s km/h zone. Slow down.',
           round(new.speed::numeric), round(new.speed_limit::numeric)),
    now() + interval '10 minutes'
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention: ended corridors go after 30 days, taking their route, signals
-- and warnings with them.

insert into public.retention_policy (table_name, keep_days) values ('corridors', 30);

create or replace function public.prune_old_data()
returns table (pruned_table text, removed bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  history_days   integer := (select keep_days from public.retention_policy where table_name = 'position_history');
  violation_days integer := (select keep_days from public.retention_policy where table_name = 'violations');
  alert_days     integer := (select keep_days from public.retention_policy where table_name = 'alerts');
  corridor_days  integer := (select keep_days from public.retention_policy where table_name = 'corridors');
  n bigint;
begin
  delete from public.position_history
   where recorded_at < now() - make_interval(days => coalesce(history_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'position_history'; removed := n; return next;

  -- Only closed violations age out. An episode still open belongs to a vehicle
  -- that is speeding right now, however old the row is.
  delete from public.violations
   where cleared_at is not null
     and occurred_at < now() - make_interval(days => coalesce(violation_days, 365));
  get diagnostics n = row_count;
  pruned_table := 'violations'; removed := n; return next;

  delete from public.alerts
   where created_at < now() - make_interval(days => coalesce(alert_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'alerts'; removed := n; return next;

  delete from public.corridors
   where status = 'ENDED'
     and coalesce(ended_at, started_at) < now() - make_interval(days => coalesce(corridor_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'corridors'; removed := n; return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime, for the dashboard and the ambulance's own screen.

alter table public.corridors replica identity full;
alter table public.corridor_signals replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime
      add table public.corridors, public.corridor_signals, public.corridor_warnings;
  end if;
end
$$;
