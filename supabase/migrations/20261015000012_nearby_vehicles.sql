-- What a driver can see around them.
--
-- The obvious implementation - subscribe to vehicle_positions over Realtime and
-- filter by distance in the app - cannot work. positions_write_own lets a
-- driver select only their own row, and Realtime delivers only rows the
-- subscriber may select, so that subscription returns their own vehicle and
-- nothing else. Widening the policy is not an option either: it would hand
-- every signed-in account the live position of the whole fleet.
--
-- So the answer is this function. It runs as the owner, checks that the caller
-- owns the vehicle they are asking as, and returns the few vehicles actually
-- near them - with no identity attached. A driver learns that something is
-- 80 m ahead doing 40 km/h and that it is an ambulance. They never learn whose
-- it is, or what it is called. That distinction is what makes continuous
-- position sharing between strangers defensible under the DPDP Act, and it is
-- worth being able to say so plainly to an authority.

-- Clamps: a radar is for the road around you, not for tracking the city.
create or replace function public.nearby_vehicles(
  p_vehicle_id uuid,
  p_radius_m   real default 400
) returns table (
  ref          text,
  lat          double precision,
  lng          double precision,
  speed        real,
  heading      real,
  vehicle_type text,
  is_emergency boolean,
  warned       boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  radius  real := least(greatest(coalesce(p_radius_m, 400), 50), 1000);
  me_lat  double precision;
  me_lng  double precision;
  pad_lat double precision;
  pad_lng double precision;
begin
  if not exists (
    select 1 from public.vehicles v
    where v.id = p_vehicle_id and v.owner = (select auth.uid())
  ) then
    raise exception 'Not your vehicle.' using errcode = '42501';
  end if;

  select p.lat, p.lng into me_lat, me_lng
  from public.vehicle_positions p
  where p.vehicle_id = p_vehicle_id;

  -- A vehicle that has not reported yet has no "around it" to describe. That
  -- is an empty answer, not an error.
  if me_lat is null then
    return;
  end if;

  -- A cheap box first, so the distance function runs over few rows. Latitude
  -- is constant; longitude narrows as you move away from the equator.
  pad_lat := radius / 110540.0;
  pad_lng := radius / (111320.0 * greatest(cos(radians(me_lat)), 0.01));

  return query
  select
    -- Stable for this pair, and different for every caller, so two drivers
    -- cannot compare notes to re-identify anyone. Never the vehicle id.
    substr(md5(p.vehicle_id::text || p_vehicle_id::text), 1, 12),
    p.lat,
    p.lng,
    p.speed,
    p.heading,
    v.vehicle_type,
    v.is_emergency_authorized,
    exists (
      select 1
      from public.corridor_warnings w
      join public.corridors c on c.id = w.corridor_id
      where w.vehicle_id = p.vehicle_id
        and c.status = 'ACTIVE'
        and c.expires_at > now()
    )
  from public.vehicle_positions p
  join public.vehicles v on v.id = p.vehicle_id
  where p.vehicle_id <> p_vehicle_id
    -- Anything older than this is a ghost: at 60 km/h it has already moved
    -- 250 m, so drawing it would be worse than drawing nothing.
    and p.updated_at > now() - interval '15 seconds'
    and p.lat between me_lat - pad_lat and me_lat + pad_lat
    and p.lng between me_lng - pad_lng and me_lng + pad_lng
    and public.approx_distance_m(me_lat, me_lng, p.lat, p.lng) <= radius
  order by public.approx_distance_m(me_lat, me_lng, p.lat, p.lng)
  limit 40;
end;
$$;

-- Every function in the public schema is a REST endpoint, so this is not
-- optional. Signed-in drivers only; the ownership check above does the rest.
revoke execute on function public.nearby_vehicles(uuid, real) from public, anon;
grant execute on function public.nearby_vehicles(uuid, real) to authenticated;

-- The staleness filter above scans by time, and the box filter by position.
create index if not exists vehicle_positions_updated_idx
  on public.vehicle_positions (updated_at desc);
