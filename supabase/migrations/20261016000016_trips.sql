-- Trips, from the position history that is already recorded.
--
-- position_history is a flat stream of points, one every one to three seconds
-- per vehicle. People do not think in points; they think in journeys. This
-- groups the stream into trips so a driver can see "Tuesday 9:12, 14 km, 26
-- minutes, one speeding" and an operator can replay exactly that.
--
-- A trip is built from MOVING points only. A parked phone keeps streaming, and
-- GPS wanders a few metres between fixes, so summing every step turns an hour
-- parked into kilometres "driven". Dropping the stationary points removes that
-- and splits trips at stops for free: a gap of more than five minutes between
-- moving points ends one trip and starts the next.
--
-- SECURITY INVOKER on purpose: it reads position_history and violations as the
-- caller, so row-level security decides whose trips come back - a driver's
-- own, or any vehicle's for an operator - with no rule restated here.

create or replace function public.vehicle_trips(
  p_vehicle_id uuid,
  p_days       integer default 7
) returns table (
  trip_no     integer,
  started_at  timestamptz,
  ended_at    timestamptz,
  points      integer,
  distance_m  double precision,
  top_speed   real,
  violations  integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with moving as (
    select
      h.recorded_at,
      h.lat,
      h.lng,
      h.speed,
      lag(h.recorded_at) over w as prev_at,
      lag(h.lat)         over w as prev_lat,
      lag(h.lng)         over w as prev_lng
    from public.position_history h
    where h.vehicle_id = p_vehicle_id
      and h.recorded_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30))
      -- Walking pace and below is noise, not travel.
      and h.speed >= 2
    window w as (order by h.recorded_at)
  ),
  marked as (
    select
      *,
      case
        when prev_at is null or recorded_at - prev_at > interval '5 minutes' then 1
        else 0
      end as starts_trip
    from moving
  ),
  numbered as (
    select *, sum(starts_trip) over (order by recorded_at)::integer as trip
    from marked
  ),
  trips as (
    select
      trip,
      min(recorded_at) as started_at,
      max(recorded_at) as ended_at,
      count(*)::integer as points,
      coalesce(
        sum(public.approx_distance_m(prev_lat, prev_lng, lat, lng)) filter (where starts_trip = 0),
        0
      ) as distance_m,
      max(speed) as top_speed
    from numbered
    group by trip
  )
  select
    t.trip,
    t.started_at,
    t.ended_at,
    t.points,
    t.distance_m,
    t.top_speed,
    (
      select count(*)::integer
      from public.violations v
      where v.vehicle_id = p_vehicle_id
        and v.occurred_at between t.started_at and t.ended_at
    )
  from trips t
  -- A blip of movement in a car park is not a journey.
  where t.distance_m >= 100
  order by t.started_at desc;
$$;

revoke execute on function public.vehicle_trips(uuid, integer) from public, anon;
grant execute on function public.vehicle_trips(uuid, integer) to authenticated;

-- Replay reads one trip's points by time; this is the index it uses.
-- (position_history_vehicle_time_idx already covers vehicle_id, recorded_at.)
