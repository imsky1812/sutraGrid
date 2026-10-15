-- Speed limits that depend on where a vehicle is.
--
-- Until now there was one number, 80 km/h, for every road in the country:
-- 80 in a school zone, and 80 on an expressway. This works out the limit at a
-- vehicle's actual position, in order of who has the most authority to say:
--
--   1. a zone with a limit an operator set (a school zone at 25)
--   2. the limit posted on the road the vehicle is on (OpenStreetMap maxspeed)
--   3. a default for that kind of road, if an authority has filled one in
--   4. the global setting, as before
--
-- "The road the vehicle is on" means the nearest imported road segment that
-- runs the way the vehicle is going - the same test the wrong-way check uses -
-- so a car on a service lane beside a highway is not held to the highway's
-- limit, and vice versa. Where no roads have been imported, nothing changes.

-- ---------------------------------------------------------------------------
-- What an authority can configure.
-- ---------------------------------------------------------------------------

alter table public.zones
  add column speed_limit_kmh real check (speed_limit_kmh > 0 and speed_limit_kmh <= 200);

/**
 * Defaults by kind of road, for roads with no posted limit.
 *
 * Deliberately empty. Limits in India are set by state notification and differ
 * by vehicle class, so no figure here would be right everywhere; an operator
 * fills in what their state has notified. An empty table changes nothing.
 */
create table public.road_class_limits (
  highway    text primary key check (char_length(highway) <= 40),
  limit_kmh  real not null check (limit_kmh > 0 and limit_kmh <= 200),
  note       text check (char_length(note) <= 200),
  updated_at timestamptz not null default now()
);

alter table public.road_class_limits enable row level security;
create policy road_class_limits_read on public.road_class_limits
  for select to authenticated using (true);
create policy road_class_limits_operator_write on public.road_class_limits
  for all to authenticated using (public.is_operator()) with check (public.is_operator());

-- ---------------------------------------------------------------------------
-- The limit at a point.
-- ---------------------------------------------------------------------------

create or replace function public.speed_limit_at(
  p_lat     double precision,
  p_lng     double precision,
  p_heading double precision
) returns table (limit_kmh real, source text, place text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  near_m   constant double precision := 20;
  pad_lat  double precision := near_m / 110540.0;
  pad_lng  double precision := near_m / (111320.0 * greatest(cos(radians(p_lat)), 0.01));
  z_limit  real;
  z_name   text;
  r_name   text;
  r_class  text;
  r_limit  real;
  c_limit  real;
begin
  -- 1. The strictest zone this point is inside.
  select z.speed_limit_kmh, z.name into z_limit, z_name
    from public.zones z
   where z.active
     and z.speed_limit_kmh is not null
     and p_lat between z.min_lat and z.max_lat
     and p_lng between z.min_lng and z.max_lng
     and public.point_in_polygon(p_lat, p_lng, z.polygon)
   order by z.speed_limit_kmh
   limit 1;
  if z_limit is not null then
    return query select z_limit, 'zone'::text, z_name;
    return;
  end if;

  -- 2 and 3. The road this vehicle is on: the nearest segment it is
  -- travelling along (either way on a two-way road).
  select s.name, s.highway, s.maxspeed_kmh into r_name, r_class, r_limit
    from public.road_segments s
   where s.min_lat <= p_lat + pad_lat and s.max_lat >= p_lat - pad_lat
     and s.min_lng <= p_lng + pad_lng and s.max_lng >= p_lng - pad_lng
     and public.segment_distance_m(p_lat, p_lng, s.a_lat, s.a_lng, s.b_lat, s.b_lng) <= near_m
     and (
       public.heading_gap(p_heading, s.bearing) < 45
       or (not s.oneway and public.heading_gap(p_heading, s.bearing + 180) < 45)
     )
   order by public.segment_distance_m(p_lat, p_lng, s.a_lat, s.a_lng, s.b_lat, s.b_lng)
   limit 1;

  if r_limit is not null then
    return query select r_limit, 'road'::text, coalesce(r_name, 'this road');
    return;
  end if;

  if r_class is not null then
    select c.limit_kmh into c_limit from public.road_class_limits c where c.highway = r_class;
    if c_limit is not null then
      return query select c_limit, 'road_class'::text, coalesce(r_name, r_class);
      return;
    end if;
  end if;

  -- 4. Nothing more specific is known.
  return query select public.speed_limit_kmh(), 'default'::text, null::text;
end;
$$;

-- The app may ask what the limit is where it stands.
revoke execute on function public.speed_limit_at(double precision, double precision, double precision)
  from public, anon;
grant execute on function public.speed_limit_at(double precision, double precision, double precision)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Speeding, measured against the limit where the vehicle is.
-- ---------------------------------------------------------------------------

create or replace function public.record_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  lim      record;
  open_id  bigint;
begin
  select * into lim from public.speed_limit_at(new.lat, new.lng, new.heading);

  select id into open_id
    from public.violations
   where vehicle_id = new.vehicle_id
     and kind = 'SPEEDING'
     and cleared_at is null
   order by occurred_at desc limit 1;

  if new.speed > lim.limit_kmh then
    if open_id is null then
      insert into public.violations (vehicle_id, kind, speed, speed_limit, lat, lng, detail)
      values (new.vehicle_id, 'SPEEDING', new.speed, lim.limit_kmh, new.lat, new.lng,
              jsonb_build_object('limit_source', lim.source, 'place', lim.place));
    else
      -- Keep the worst speed, and the strictest limit it was broken against.
      update public.violations
         set speed = greatest(speed, new.speed),
             speed_limit = least(speed_limit, lim.limit_kmh)
       where id = open_id;
    end if;
  elsif open_id is not null and new.speed < lim.limit_kmh - 5 then
    update public.violations set cleared_at = now() where id = open_id;
  end if;

  return new;
exception when others then
  -- This now does a zone and road lookup on every position. Like the newer
  -- checks, it must never cost a vehicle its tracking.
  raise warning 'speeding check failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

-- Say which limit was broken, and where, when it is not the default.
create or replace function public.alert_on_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  source text := new.detail ->> 'limit_source';
  place  text := new.detail ->> 'place';
begin
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

  if exists (
    select 1 from public.corridors
     where vehicle_id = new.vehicle_id and status = 'ACTIVE' and expires_at > now()
  ) then
    return new;
  end if;

  insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
  values (
    null, new.vehicle_id, 'RULE', 'WARNING',
    case
      when source = 'zone' then
        format('Overspeeding: %s km/h in %s, where the limit is %s km/h. Slow down.',
               round(new.speed::numeric), place, round(new.speed_limit::numeric))
      when source in ('road', 'road_class') then
        format('Overspeeding: %s km/h on %s, where the limit is %s km/h. Slow down.',
               round(new.speed::numeric), place, round(new.speed_limit::numeric))
      else
        format('Overspeeding: %s km/h in a %s km/h zone. Slow down.',
               round(new.speed::numeric), round(new.speed_limit::numeric))
    end,
    now() + interval '10 minutes'
  );
  return new;
end;
$$;
