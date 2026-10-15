-- Collision warning for crossing paths.
--
-- When two SUTRA vehicles are heading for the same point - typically a
-- junction where neither driver can see the other - both are warned a few
-- seconds before they would meet.
--
-- What this deliberately does NOT try to do, and why: phone GPS is good to
-- roughly 5-10 m, and adjacent lanes are 3.5 m apart. A naive "they will pass
-- within 12 m" test fires on every oncoming car on a two-lane road and every
-- overtake, because those genuinely do pass within 4 m. A warning that sounds
-- all the time is worse than none: drivers learn to ignore it. So only paths
-- that cross at an angle (30-150 degrees apart) are considered. Head-on,
-- rear-end and lane-change risks need lane-level positioning, which a phone
-- does not have. A wrong-way driver is a separate check (violations, phase 8).
--
-- The test is closest point of approach. Treat both vehicles as moving in
-- straight lines at their current speed and heading; find when they are
-- nearest; warn if that is soon and close:
--
--   r = their position relative to mine,  v = their velocity relative to mine
--   t = -(r . v) / |v|^2        miss = |r + v t|
--
-- Thresholds are settings, not code, so an authority can tune them without a
-- deploy.

-- ---------------------------------------------------------------------------
-- Shared geometry, matching approx_distance_m and the app's geo.ts.
-- ---------------------------------------------------------------------------

/** Compass bearing from one point to another: 0 north, 90 east. */
create or replace function public.bearing_deg(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when lat1 = lat2 and lng1 = lng2 then 0
    else mod(
      degrees(atan2(
        (lng2 - lng1) * 111320 * cos(radians((lat1 + lat2) / 2)),
        (lat2 - lat1) * 110540
      ))::numeric + 360,
      360
    )::double precision
  end
$$;

/** Where something is from a driver's seat, in the words a warning would use. */
create or replace function public.relative_side(
  heading double precision, bearing double precision
) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when rel < 30 or rel > 330 then 'ahead'
    when rel < 150 then 'from your right'
    when rel < 210 then 'from behind'
    else 'from your left'
  end
  from (select mod((bearing - heading)::numeric + 360, 360) as rel) s
$$;

/** A number from settings, or the default when it has not been set. */
create or replace function public.setting_num(p_key text, p_default double precision)
returns double precision
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select (value #>> '{}')::double precision from public.settings where key = p_key),
    p_default
  )
$$;

insert into public.settings (key, value) values
  ('conflict_horizon_s', '6'),        -- warn this many seconds ahead
  ('conflict_miss_m', '12'),          -- ...if they would pass closer than this
  ('conflict_min_speed_kmh', '8'),    -- both must be moving at least this fast
  ('conflict_cooldown_s', '30')       -- one warning per pair per encounter
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- One warning per pair per encounter.
-- ---------------------------------------------------------------------------

create table public.conflict_warnings (
  -- Stored in a fixed order so A-meets-B and B-meets-A are the same row.
  vehicle_a  uuid not null references public.vehicles (id) on delete cascade,
  vehicle_b  uuid not null references public.vehicles (id) on delete cascade,
  warned_at  timestamptz not null default now(),
  primary key (vehicle_a, vehicle_b),
  check (vehicle_a < vehicle_b)
);

-- Internal bookkeeping only; nothing for a client to read or write.
alter table public.conflict_warnings enable row level security;

-- ---------------------------------------------------------------------------
-- The check, on every position.
-- ---------------------------------------------------------------------------

create or replace function public.detect_conflicts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Read in the body, not here: an error while declaring escapes the
  -- exception handler below, and this must never block a position.
  horizon   double precision;
  miss_max  double precision;
  min_speed double precision;
  cooldown  double precision;
  -- Search far enough to catch two vehicles at 60 km/h each, six seconds out.
  reach     double precision := 250;
  pad_lat   double precision;
  pad_lng   double precision;
  my_vx     double precision;
  my_vy     double precision;
  other     record;
  age_s     double precision;
  rx        double precision;
  ry        double precision;
  vx        double precision;
  vy        double precision;
  vv        double precision;
  t         double precision;
  miss      double precision;
  angle     double precision;
  a         uuid;
  b         uuid;
  claimed   integer;
begin
  horizon   := public.setting_num('conflict_horizon_s', 6);
  miss_max  := public.setting_num('conflict_miss_m', 12);
  min_speed := public.setting_num('conflict_min_speed_kmh', 8);
  cooldown  := public.setting_num('conflict_cooldown_s', 30);

  -- A parked or crawling vehicle: nothing to project. If someone is heading
  -- for it, their own frame does the work.
  if new.speed < min_speed then
    return new;
  end if;

  -- Braking is the driver already responding. Warning them now only adds
  -- noise, and at every red light it would be constant.
  if tg_op = 'UPDATE' and new.speed < old.speed - 3 then
    return new;
  end if;

  my_vx := new.speed / 3.6 * sin(radians(new.heading));
  my_vy := new.speed / 3.6 * cos(radians(new.heading));

  pad_lat := reach / 110540.0;
  pad_lng := reach / (111320.0 * greatest(cos(radians(new.lat)), 0.01));

  for other in
    select p.vehicle_id, p.lat, p.lng, p.speed, p.heading, p.updated_at
    from public.vehicle_positions p
    where p.vehicle_id <> new.vehicle_id
      and p.updated_at > now() - interval '6 seconds'
      and p.speed >= min_speed
      and p.lat between new.lat - pad_lat and new.lat + pad_lat
      and p.lng between new.lng - pad_lng and new.lng + pad_lng
  loop
    -- Crossing paths only (see the note at the top).
    angle := abs(mod((other.heading - new.heading)::numeric + 360, 360));
    if angle > 180 then angle := 360 - angle; end if;
    if angle < 30 or angle > 150 then continue; end if;

    -- Is the other one braking? Its last two recorded speeds say.
    if (
      select h1.speed < h2.speed - 3
      from (select speed, recorded_at from public.position_history
             where vehicle_id = other.vehicle_id order by recorded_at desc limit 1) h1,
           (select speed from public.position_history
             where vehicle_id = other.vehicle_id order by recorded_at desc offset 1 limit 1) h2
    ) then
      continue;
    end if;

    -- Their row may be a second or two older than mine; carry it forward.
    age_s := greatest(extract(epoch from (now() - other.updated_at)), 0);

    vx := other.speed / 3.6 * sin(radians(other.heading)) - my_vx;
    vy := other.speed / 3.6 * cos(radians(other.heading)) - my_vy;
    rx := (other.lng - new.lng) * 111320 * cos(radians((other.lat + new.lat) / 2))
          + other.speed / 3.6 * sin(radians(other.heading)) * age_s;
    ry := (other.lat - new.lat) * 110540
          + other.speed / 3.6 * cos(radians(other.heading)) * age_s;

    vv := vx * vx + vy * vy;
    if vv < 1 then continue; end if;

    t := -(rx * vx + ry * vy) / vv;
    -- Already past each other, or too far off to be worth a warning yet.
    if t <= 0 or t > horizon then continue; end if;

    miss := sqrt(power(rx + vx * t, 2) + power(ry + vy * t, 2));
    if miss > miss_max then continue; end if;

    -- Once per pair per encounter.
    a := least(new.vehicle_id, other.vehicle_id);
    b := greatest(new.vehicle_id, other.vehicle_id);
    insert into public.conflict_warnings (vehicle_a, vehicle_b, warned_at)
    values (a, b, now())
    on conflict (vehicle_a, vehicle_b) do update
      set warned_at = now()
      where public.conflict_warnings.warned_at < now() - make_interval(secs => cooldown);
    get diagnostics claimed = row_count;
    if claimed = 0 then continue; end if;

    -- Both drivers, each told which side the danger is on.
    insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
    values
      (null, new.vehicle_id, 'HAZARD', 'CRITICAL',
       format('Collision risk: a vehicle is closing %s, about %s s away. Slow down.',
              public.relative_side(new.heading, public.bearing_deg(new.lat, new.lng, other.lat, other.lng)),
              greatest(round(t::numeric), 1)),
       now() + interval '1 minute'),
      (null, other.vehicle_id, 'HAZARD', 'CRITICAL',
       format('Collision risk: a vehicle is closing %s, about %s s away. Slow down.',
              public.relative_side(other.heading, public.bearing_deg(other.lat, other.lng, new.lat, new.lng)),
              greatest(round(t::numeric), 1)),
       now() + interval '1 minute');
  end loop;

  return new;
exception when others then
  -- This runs inside every phone's position update. A bug here must never
  -- cost a vehicle its tracking, so it logs and lets the position through.
  raise warning 'conflict check failed for %: %', new.vehicle_id, sqlerrm;
  return new;
end;
$$;

create trigger vehicle_positions_conflicts
  after insert or update on public.vehicle_positions
  for each row execute function public.detect_conflicts();

-- Internal: nothing here is for clients to call.
revoke execute on function public.detect_conflicts() from public, anon, authenticated;
revoke execute on function public.setting_num(text, double precision) from public, anon, authenticated;

-- No retention entry: the table holds one row per pair of vehicles that have
-- ever met, overwritten in place, so it is bounded by fleet size, not time.
