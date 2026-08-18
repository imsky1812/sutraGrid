-- Live position, one row per vehicle, upserted at the telemetry cadence.
--
-- Note what is absent: there is no emergency column. Emergency status is
-- derived by joining to vehicles.is_emergency_authorized, so a modified client
-- has nothing to assert. The previous Node relay accepted an isEmergency field
-- in every frame and had to overwrite it server-side.
--
-- Range checks live here rather than in application code so they cannot be
-- bypassed by a client, and so one malformed frame cannot poison shared state
-- the way it could in the relay.

create table public.vehicle_positions (
  vehicle_id       uuid primary key references public.vehicles (id) on delete cascade,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  speed            real not null default 0 check (speed >= 0 and speed <= 500),
  heading          real not null default 0 check (heading >= 0 and heading <= 360),
  destination_lat  double precision check (destination_lat between -90 and 90),
  destination_lng  double precision check (destination_lng between -180 and 180),
  destination_name text check (char_length(destination_name) <= 120),
  alert_message    text check (char_length(alert_message) <= 200),
  updated_at       timestamptz not null default now()
);

alter table public.vehicle_positions enable row level security;

create policy positions_write_own on public.vehicle_positions
  for all
  using (
    exists (
      select 1 from public.vehicles v
      where v.id = vehicle_id and v.owner = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.vehicles v
      where v.id = vehicle_id and v.owner = (select auth.uid())
    )
  );

-- The operator role exists so the schema is complete and covered by tests.
-- Nothing reads through it until the admin dashboard is migrated off the Node
-- relay in a later phase.
--
-- Roles are cluster-level, so `supabase db reset` does not drop them. Without
-- this guard the migration fails on every reset after the first.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'operator') then
    create role operator nologin;
  end if;
end
$$;

grant usage on schema public to operator;
grant select on public.vehicles, public.vehicle_positions to operator;

create policy positions_select_operator on public.vehicle_positions
  for select to operator using (true);

create policy vehicles_select_operator on public.vehicles
  for select to operator using (true);

-- Realtime is a Supabase construct. The publication does not exist when these
-- migrations run against a plain Postgres (the PGlite test harness), so this is
-- guarded rather than assumed.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.vehicle_positions;
  end if;
end
$$;
