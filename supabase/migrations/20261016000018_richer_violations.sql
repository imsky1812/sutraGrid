-- Two more kinds of violation: harsh braking, and driving the wrong way down a
-- one-way road.
--
-- Adding them exposed two assumptions in the speeding code that only held
-- while speeding was the only kind, and both are fixed here first:
--
--   * record_speed_violation found "the open violation for this vehicle"
--     without asking what kind it was, so it would have overwritten a harsh
--     brake's speed with the next frame's.
--   * alert_on_speed_violation fired on every violation and always said
--     "Overspeeding", so a harsh brake would have told the driver they were
--     speeding.

-- ---------------------------------------------------------------------------
-- The kinds, and somewhere to say what happened.
-- ---------------------------------------------------------------------------

alter table public.violations drop constraint if exists violations_kind_check;
alter table public.violations
  add constraint violations_kind_check check (kind in ('SPEEDING', 'HARSH_BRAKE', 'WRONG_WAY'));

-- What a speed and a limit cannot describe: how hard the braking was, which
-- road was driven the wrong way.
alter table public.violations add column detail jsonb;

insert into public.settings (key, value) values
  -- 0.4 g. Firm braking for a junction is around 0.3 g; GPS speed is noisy
  -- enough that a lower figure would flag ordinary driving.
  ('harsh_brake_mps2', '3.9'),
  -- Consecutive fixes against a one-way road before it counts. One fix could
  -- be a GPS jump onto the wrong carriageway.
  ('wrong_way_fixes', '3')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Speeding: only ever look at speeding episodes.
-- ---------------------------------------------------------------------------

create or replace function public.record_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  limit_kmh real := public.speed_limit_kmh();
  open_id   bigint;
begin
  select id into open_id
    from public.violations
   where vehicle_id = new.vehicle_id
     and kind = 'SPEEDING'
     and cleared_at is null
   order by occurred_at desc limit 1;

  if new.speed > limit_kmh then
    if open_id is null then
      insert into public.violations (vehicle_id, kind, speed, speed_limit, lat, lng)
      values (new.vehicle_id, 'SPEEDING', new.speed, limit_kmh, new.lat, new.lng);
    else
      update public.violations set speed = greatest(speed, new.speed) where id = open_id;
    end if;
  elsif open_id is not null and new.speed < limit_kmh - 5 then
    update public.violations set cleared_at = now() where id = open_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telling the driver: once per violation, in words that fit what happened.
-- ---------------------------------------------------------------------------

create or replace function public.alert_on_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Harsh braking is recorded, never announced. Beeping at a driver in the
  -- second after an emergency stop distracts them at the worst moment, and
  -- there is nothing left for them to do about it.
  if new.kind = 'HARSH_BRAKE' then
    return new;
  end if;

  if new.kind = 'WRONG_WAY' then
    insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
    values (null, new.vehicle_id, 'RULE', 'CRITICAL',
            coalesce(
              format('Wrong way: %s is one-way. Stop safely and turn around.', new.detail ->> 'road'),
              'Wrong way: this road is one-way. Stop safely and turn around.'
            ),
            now() + interval '5 minutes');
    return new;
  end if;

  -- An ambulance with its corridor open is expected to be fast.
  if exists (
    select 1 from public.corridors
     where vehicle_id = new.vehicle_id and status = 'ACTIVE' and expires_at > now()
  ) then
    return new;
  end if;

  insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
  values (
    null, new.vehicle_id, 'RULE', 'WARNING',
    format('Overspeeding: %s km/h in a %s km/h zone. Slow down.',
           round(new.speed::numeric), round(new.speed_limit::numeric)),
    now() + interval '10 minutes'
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Harsh braking: the speed drop between two consecutive fixes.
-- ---------------------------------------------------------------------------

create or replace function public.detect_harsh_brake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  threshold double precision;
  dt        double precision;
  decel     double precision;
begin
  threshold := public.setting_num('harsh_brake_mps2', 3.9);

  -- Below 20 km/h GPS speed is too noisy for the difference to mean much.
  if old.speed < 20 or new.speed >= old.speed then
    return new;
  end if;

  -- The time between the two fixes. Outside this window the drop is either
  -- a duplicate frame or spread over too long to be a single stop.
  dt := extract(epoch from (new.updated_at - old.updated_at));
  if dt < 0.5 or dt > 5 then
    return new;
  end if;

  decel := (old.speed - new.speed) / 3.6 / dt;
  if decel < threshold then
    return new;
  end if;

  -- One stop is one event, however many frames it spans.
  if exists (
    select 1 from public.violations
     where vehicle_id = new.vehicle_id
       and kind = 'HARSH_BRAKE'
       and occurred_at > now() - interval '30 seconds'
  ) then
    return new;
  end if;

  insert into public.violations
    (vehicle_id, kind, speed, speed_limit, lat, lng, cleared_at, detail)
  values (
    new.vehicle_id, 'HARSH_BRAKE', old.speed, public.speed_limit_kmh(), new.lat, new.lng, now(),
    jsonb_build_object(
      'from_kmh', round(old.speed::numeric),
      'to_kmh', round(new.speed::numeric),
      'decel_mps2', round(decel::numeric, 1),
      'seconds', round(dt::numeric, 1)
    )
  );
  return new;
exception when others then
  -- Inside every position update: never cost a vehicle its tracking.
  raise warning 'harsh-brake check failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

create trigger vehicle_positions_harsh_brake
  after update on public.vehicle_positions
  for each row execute function public.detect_harsh_brake();

-- ---------------------------------------------------------------------------
-- Roads, from OpenStreetMap. Needed to know what "the wrong way" is; also the
-- base for per-road speed limits.
-- ---------------------------------------------------------------------------

create table public.road_segments (
  id            bigint generated always as identity primary key,
  osm_way_id    bigint not null,
  name          text check (char_length(name) <= 200),
  highway       text,
  -- From a to b is the direction of travel when the road is one-way.
  a_lat         double precision not null check (a_lat between -90 and 90),
  a_lng         double precision not null check (a_lng between -180 and 180),
  b_lat         double precision not null check (b_lat between -90 and 90),
  b_lng         double precision not null check (b_lng between -180 and 180),
  oneway        boolean not null default false,
  maxspeed_kmh  real check (maxspeed_kmh > 0 and maxspeed_kmh <= 200),
  bearing       double precision generated always as
                  (public.bearing_deg(a_lat, a_lng, b_lat, b_lng)) stored,
  min_lat       double precision generated always as (least(a_lat, b_lat)) stored,
  max_lat       double precision generated always as (greatest(a_lat, b_lat)) stored,
  min_lng       double precision generated always as (least(a_lng, b_lng)) stored,
  max_lng       double precision generated always as (greatest(a_lng, b_lng)) stored,
  imported_at   timestamptz not null default now()
);

create index road_segments_way_idx on public.road_segments (osm_way_id);
create index road_segments_box_idx on public.road_segments (min_lat, max_lat, min_lng, max_lng);

alter table public.road_segments enable row level security;

-- Public map data: anyone signed in may read it. Only operators load it.
create policy road_segments_read on public.road_segments
  for select to authenticated using (true);
create policy road_segments_operator_insert on public.road_segments
  for insert to authenticated with check (public.is_operator());
create policy road_segments_operator_delete on public.road_segments
  for delete to authenticated using (public.is_operator());

/** Shortest distance from a point to a segment, in metres (planar). */
create or replace function public.segment_distance_m(
  plat double precision, plng double precision,
  alat double precision, alng double precision,
  blat double precision, blng double precision
) returns double precision
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  -- Metres, with a at the origin: p is the point, s is the segment.
  k    double precision := 111320 * cos(radians(plat));
  px   double precision := (plng - alng) * k;
  py   double precision := (plat - alat) * 110540;
  sx   double precision := (blng - alng) * k;
  sy   double precision := (blat - alat) * 110540;
  len2 double precision := sx * sx + sy * sy;
  t    double precision;
begin
  if len2 = 0 then
    return sqrt(px * px + py * py);
  end if;
  t := greatest(0, least(1, (px * sx + py * sy) / len2));
  return sqrt(power(px - t * sx, 2) + power(py - t * sy, 2));
end;
$$;

/** Smallest angle between two compass headings, 0 to 180. */
create or replace function public.heading_gap(h1 double precision, h2 double precision)
returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select case when d > 180 then 360 - d else d end
  from (select abs(mod((h1 - h2)::numeric + 720, 360))::double precision as d) s
$$;

-- ---------------------------------------------------------------------------
-- Wrong way.
-- ---------------------------------------------------------------------------

create table public.wrong_way_streaks (
  vehicle_id  uuid primary key references public.vehicles (id) on delete cascade,
  fixes       integer not null default 0,
  last_at     timestamptz not null default now()
);
alter table public.wrong_way_streaks enable row level security;

create or replace function public.detect_wrong_way()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  needed   integer;
  near_m   constant double precision := 15;
  pad_lat  double precision;
  pad_lng  double precision;
  aligned  boolean;
  way_id   bigint;
  way_name text;
  streak   integer;
begin
  needed := public.setting_num('wrong_way_fixes', 3)::integer;

  -- Heading means little at a crawl, and a vehicle reversing out of a drive
  -- is not driving the wrong way.
  if new.speed < 10 then
    delete from public.wrong_way_streaks where vehicle_id = new.vehicle_id;
    return new;
  end if;

  pad_lat := near_m / 110540.0;
  pad_lng := near_m / (111320.0 * greatest(cos(radians(new.lat)), 0.01));

  -- Any road nearby that this direction of travel is allowed on. On a dual
  -- carriageway the opposite carriageway is often within GPS error, so being
  -- near a one-way road going the other way proves nothing on its own.
  select exists (
    select 1 from public.road_segments s
     where s.min_lat <= new.lat + pad_lat and s.max_lat >= new.lat - pad_lat
       and s.min_lng <= new.lng + pad_lng and s.max_lng >= new.lng - pad_lng
       and public.segment_distance_m(new.lat, new.lng, s.a_lat, s.a_lng, s.b_lat, s.b_lng) <= near_m
       and (
         public.heading_gap(new.heading, s.bearing) < 45
         or (not s.oneway and public.heading_gap(new.heading, s.bearing + 180) < 45)
       )
  ) into aligned;

  select s.osm_way_id, s.name into way_id, way_name
    from public.road_segments s
   where not aligned
     and s.oneway
     and s.min_lat <= new.lat + pad_lat and s.max_lat >= new.lat - pad_lat
     and s.min_lng <= new.lng + pad_lng and s.max_lng >= new.lng - pad_lng
     and public.segment_distance_m(new.lat, new.lng, s.a_lat, s.a_lng, s.b_lat, s.b_lng) <= near_m
     and public.heading_gap(new.heading, s.bearing + 180) < 35
   order by public.segment_distance_m(new.lat, new.lng, s.a_lat, s.a_lng, s.b_lat, s.b_lng)
   limit 1;

  if way_id is null then
    delete from public.wrong_way_streaks where vehicle_id = new.vehicle_id;
    return new;
  end if;

  -- One fix against the road could be a GPS jump. Several in a row is not.
  insert into public.wrong_way_streaks (vehicle_id, fixes, last_at)
  values (new.vehicle_id, 1, now())
  on conflict (vehicle_id) do update
    set fixes = case
                  when public.wrong_way_streaks.last_at < now() - interval '15 seconds' then 1
                  else public.wrong_way_streaks.fixes + 1
                end,
        last_at = now()
  returning fixes into streak;

  if streak < needed then
    return new;
  end if;

  delete from public.wrong_way_streaks where vehicle_id = new.vehicle_id;

  -- Once per road, not once every few seconds while they find somewhere to turn.
  if exists (
    select 1 from public.violations
     where vehicle_id = new.vehicle_id
       and kind = 'WRONG_WAY'
       and occurred_at > now() - interval '2 minutes'
  ) then
    return new;
  end if;

  insert into public.violations
    (vehicle_id, kind, speed, speed_limit, lat, lng, cleared_at, detail)
  values (
    new.vehicle_id, 'WRONG_WAY', new.speed, public.speed_limit_kmh(), new.lat, new.lng, now(),
    jsonb_build_object('road', coalesce(way_name, 'This road'), 'osm_way_id', way_id)
  );
  return new;
exception when others then
  raise warning 'wrong-way check failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

create trigger vehicle_positions_wrong_way
  after insert or update on public.vehicle_positions
  for each row execute function public.detect_wrong_way();

revoke execute on function public.detect_harsh_brake() from public, anon, authenticated;
revoke execute on function public.detect_wrong_way() from public, anon, authenticated;
