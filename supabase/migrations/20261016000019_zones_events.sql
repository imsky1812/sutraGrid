-- Geofencing, and one record of everything that happens to a vehicle.
--
-- Until now each check kept its own shape: speeding in violations, corridor
-- warnings in their own table, collision encounters in another, and the
-- console assembled an event log from strings in the browser. This adds a
-- single events table with a fixed set of kinds - the event/notification
-- model Traccar uses - which every check writes into, so "what happened to
-- this vehicle today" is one query.
--
-- It also adds zones: named areas an operator draws. Entering or leaving one
-- is an event, and a zone can carry a message that is sent to the driver on
-- entry - "School zone: slow down, children crossing" - which, like every
-- alert, also arrives by push.

-- ---------------------------------------------------------------------------
-- Zones.
-- ---------------------------------------------------------------------------

create table public.zones (
  id             bigint generated always as identity primary key,
  name           text not null check (char_length(name) between 1 and 80),
  kind           text not null default 'CUSTOM'
                 check (kind in ('SCHOOL', 'HOSPITAL', 'RESTRICTED', 'DEPOT', 'CUSTOM')),
  -- [[lat, lng], ...], not closed: the last point joins back to the first.
  polygon        jsonb not null,
  -- Said to a driver on entering, if set.
  alert_message  text check (char_length(alert_message) <= 200),
  active         boolean not null default true,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  -- Filled from the polygon, so the position check can skip far zones cheaply.
  min_lat        double precision,
  max_lat        double precision,
  min_lng        double precision,
  max_lng        double precision
);

/** Validate a polygon and record its bounding box. */
create or replace function public.prepare_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  if jsonb_typeof(new.polygon) <> 'array' then
    raise exception 'A zone must be a list of [lat, lng] points.' using errcode = '22023';
  end if;
  n := jsonb_array_length(new.polygon);
  if n < 3 or n > 200 then
    raise exception 'A zone needs between 3 and 200 points, not %.', n using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(new.polygon) p
     where jsonb_typeof(p) <> 'array'
        or jsonb_array_length(p) <> 2
        or jsonb_typeof(p -> 0) <> 'number'
        or jsonb_typeof(p -> 1) <> 'number'
        or (p ->> 0)::double precision not between -90 and 90
        or (p ->> 1)::double precision not between -180 and 180
  ) then
    raise exception 'Every point must be [lat, lng] within valid ranges.' using errcode = '22023';
  end if;

  select min((p ->> 0)::double precision), max((p ->> 0)::double precision),
         min((p ->> 1)::double precision), max((p ->> 1)::double precision)
    into new.min_lat, new.max_lat, new.min_lng, new.max_lng
    from jsonb_array_elements(new.polygon) p;
  return new;
end;
$$;

create trigger zones_prepare
  before insert or update of polygon on public.zones
  for each row execute function public.prepare_zone();

create index zones_box_idx on public.zones (min_lat, max_lat, min_lng, max_lng) where active;

alter table public.zones enable row level security;

-- Where the zones are is not secret: drivers can be shown them. Only
-- operators draw, change or remove them.
create policy zones_read on public.zones
  for select to authenticated using (true);
create policy zones_operator_insert on public.zones
  for insert to authenticated with check (public.is_operator());
create policy zones_operator_update on public.zones
  for update to authenticated using (public.is_operator()) with check (public.is_operator());
create policy zones_operator_delete on public.zones
  for delete to authenticated using (public.is_operator());

/** Ray casting: is the point inside the polygon? Edges are lat/lng straight lines. */
create or replace function public.point_in_polygon(
  plat double precision, plng double precision, polygon jsonb
) returns boolean
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  n       integer := jsonb_array_length(polygon);
  inside  boolean := false;
  i       integer;
  j       integer := n - 1;
  ilat    double precision;
  ilng    double precision;
  jlat    double precision;
  jlng    double precision;
begin
  for i in 0 .. n - 1 loop
    ilat := (polygon -> i ->> 0)::double precision;
    ilng := (polygon -> i ->> 1)::double precision;
    jlat := (polygon -> j ->> 0)::double precision;
    jlng := (polygon -> j ->> 1)::double precision;
    if ((ilat > plat) <> (jlat > plat))
       and (plng < (jlng - ilng) * (plat - ilat) / (jlat - ilat) + ilng) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end;
$$;

-- ---------------------------------------------------------------------------
-- Events.
-- ---------------------------------------------------------------------------

create table public.events (
  id           bigint generated always as identity primary key,
  vehicle_id   uuid not null references public.vehicles (id) on delete cascade,
  kind         text not null check (kind in (
                 'ZONE_ENTER', 'ZONE_EXIT',
                 'OVERSPEED', 'HARSH_BRAKE', 'WRONG_WAY',
                 'CONFLICT',
                 'CORRIDOR_START', 'CORRIDOR_END'
               )),
  occurred_at  timestamptz not null default now(),
  lat          double precision,
  lng          double precision,
  zone_id      bigint references public.zones (id) on delete set null,
  detail       jsonb
);

create index events_vehicle_time_idx on public.events (vehicle_id, occurred_at desc);
create index events_time_idx on public.events (occurred_at desc);

alter table public.events enable row level security;

-- Same rule as everything else: your own vehicles, or all of them for an
-- operator. Written only by the triggers below.
create policy events_select_own on public.events
  for select to authenticated using (
    exists (select 1 from public.vehicles v where v.id = vehicle_id and v.owner = (select auth.uid()))
  );
create policy events_select_operator on public.events
  for select to authenticated using (public.is_operator());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.events;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Zone crossings, on every position.
-- ---------------------------------------------------------------------------

create table public.zone_presence (
  vehicle_id     uuid not null references public.vehicles (id) on delete cascade,
  zone_id        bigint not null references public.zones (id) on delete cascade,
  entered_at     timestamptz not null default now(),
  -- GPS wanders across a boundary. Leaving takes two fixes in a row outside,
  -- or a vehicle parked on the edge would enter and leave every few seconds.
  outside_fixes  integer not null default 0,
  primary key (vehicle_id, zone_id)
);
alter table public.zone_presence enable row level security;

create or replace function public.check_zones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  z        record;
  gone     record;
begin
  -- Entering.
  for z in
    select id, name, kind, alert_message
      from public.zones
     where active
       and new.lat between min_lat and max_lat
       and new.lng between min_lng and max_lng
       and public.point_in_polygon(new.lat, new.lng, polygon)
  loop
    insert into public.zone_presence (vehicle_id, zone_id)
    values (new.vehicle_id, z.id)
    on conflict (vehicle_id, zone_id) do update set outside_fixes = 0;

    -- Only a genuine arrival: already inside means the row existed.
    if not found or (select entered_at from public.zone_presence
                      where vehicle_id = new.vehicle_id and zone_id = z.id) < now() then
      continue;
    end if;

    -- Back in within two minutes is the same visit: no second event, no
    -- second alert.
    if exists (
      select 1 from public.events
       where vehicle_id = new.vehicle_id and zone_id = z.id
         and kind = 'ZONE_EXIT' and occurred_at > now() - interval '2 minutes'
    ) then
      continue;
    end if;

    insert into public.events (vehicle_id, kind, lat, lng, zone_id, detail)
    values (new.vehicle_id, 'ZONE_ENTER', new.lat, new.lng, z.id,
            jsonb_build_object('zone', z.name, 'zone_kind', z.kind));

    if z.alert_message is not null then
      insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
      values (null, new.vehicle_id, 'HAZARD', 'WARNING', z.alert_message, now() + interval '10 minutes');
    end if;
  end loop;

  -- Leaving: zones this vehicle was in that no longer contain it.
  for gone in
    select p.zone_id, p.entered_at, p.outside_fixes, zz.name
      from public.zone_presence p
      join public.zones zz on zz.id = p.zone_id
     where p.vehicle_id = new.vehicle_id
       and not (
         zz.active
         and new.lat between zz.min_lat and zz.max_lat
         and new.lng between zz.min_lng and zz.max_lng
         and public.point_in_polygon(new.lat, new.lng, zz.polygon)
       )
  loop
    if gone.outside_fixes + 1 < 2 then
      update public.zone_presence set outside_fixes = outside_fixes + 1
       where vehicle_id = new.vehicle_id and zone_id = gone.zone_id;
      continue;
    end if;

    delete from public.zone_presence where vehicle_id = new.vehicle_id and zone_id = gone.zone_id;
    insert into public.events (vehicle_id, kind, lat, lng, zone_id, detail)
    values (new.vehicle_id, 'ZONE_EXIT', new.lat, new.lng, gone.zone_id,
            jsonb_build_object(
              'zone', gone.name,
              'minutes_inside', round((extract(epoch from now() - gone.entered_at) / 60)::numeric, 1)
            ));
  end loop;

  return new;
exception when others then
  -- Inside every position update: never cost a vehicle its tracking.
  raise warning 'zone check failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

create trigger vehicle_positions_zones
  after insert or update on public.vehicle_positions
  for each row execute function public.check_zones();

-- ---------------------------------------------------------------------------
-- Everything else that already happens, recorded as events too.
-- ---------------------------------------------------------------------------

create or replace function public.violation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.events (vehicle_id, kind, occurred_at, lat, lng, detail)
  values (
    new.vehicle_id,
    case new.kind when 'SPEEDING' then 'OVERSPEED' else new.kind end,
    new.occurred_at, new.lat, new.lng,
    coalesce(new.detail, '{}'::jsonb)
      || jsonb_build_object('speed', round(new.speed::numeric), 'limit', round(new.speed_limit::numeric))
  );
  return new;
exception when others then
  raise warning 'violation event failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

create trigger violations_event
  after insert on public.violations
  for each row execute function public.violation_event();

/** A collision warning is one encounter between two vehicles: one event each. */
create or replace function public.conflict_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.events (vehicle_id, kind, lat, lng, detail)
  select p.vehicle_id, 'CONFLICT', p.lat, p.lng,
         jsonb_build_object('speed', round(p.speed::numeric))
    from public.vehicle_positions p
   where p.vehicle_id in (new.vehicle_a, new.vehicle_b);
  return new;
exception when others then
  raise warning 'conflict event failed: %', sqlerrm;
  return new;
end;
$$;

-- Updated rows are re-warnings after the cooldown (the upsert only updates
-- when it claims a new encounter), so both insert and update are events.
create trigger conflict_warnings_event
  after insert or update on public.conflict_warnings
  for each row execute function public.conflict_event();

create or replace function public.corridor_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.events (vehicle_id, kind, lat, lng, detail)
    values (new.vehicle_id, 'CORRIDOR_START', new.destination_lat, new.destination_lng,
            jsonb_build_object('destination', new.destination_name,
                               'distance_m', round(coalesce(new.distance_m, 0)::numeric)));
  elsif new.status = 'ENDED' and old.status is distinct from 'ENDED' then
    insert into public.events (vehicle_id, kind, lat, lng, detail)
    values (new.vehicle_id, 'CORRIDOR_END', new.destination_lat, new.destination_lng,
            jsonb_build_object('destination', new.destination_name,
                               'minutes', round((extract(epoch from coalesce(new.ended_at, now()) - new.started_at) / 60)::numeric, 1)));
  end if;
  return new;
exception when others then
  raise warning 'corridor event failed: %', sqlerrm;
  return new;
end;
$$;

create trigger corridors_event
  after insert or update of status on public.corridors
  for each row execute function public.corridor_event();

revoke execute on function public.check_zones() from public, anon, authenticated;
revoke execute on function public.violation_event() from public, anon, authenticated;
revoke execute on function public.conflict_event() from public, anon, authenticated;
revoke execute on function public.corridor_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention: events go after 30 days, like alerts.
-- ---------------------------------------------------------------------------

insert into public.retention_policy (table_name, keep_days) values ('events', 30)
on conflict (table_name) do nothing;

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
  event_days     integer := (select keep_days from public.retention_policy where table_name = 'events');
  n bigint;
begin
  delete from public.position_history
   where recorded_at < now() - make_interval(days => coalesce(history_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'position_history'; removed := n; return next;

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

  delete from public.events
   where occurred_at < now() - make_interval(days => coalesce(event_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'events'; removed := n; return next;
end;
$$;

revoke execute on function public.prune_old_data() from public, anon, authenticated;
