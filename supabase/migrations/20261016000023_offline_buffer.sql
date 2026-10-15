-- Positions a phone recorded while it had no signal.
--
-- When the network drops - a tunnel, a basement car park, a dead zone on a
-- highway - the app now keeps its positions and sends them once it is back.
-- They must not go where live positions go. vehicle_positions is the vehicle's
-- position NOW: replaying ten minutes of old fixes into it would move the
-- vehicle backwards on every map, and every check that runs on a position
-- (harsh braking, collision warnings, zones, corridors) would act on stale
-- data and warn people about something long past.
--
-- So buffered positions go into position_history only, through this
-- function: the vehicle's track is complete, trips and replay include the
-- stretch without signal, and nothing live is disturbed.
--
-- What it deliberately does not do: run the speeding check over them. A
-- violation is evidence; positions sent late, with timestamps the phone
-- supplied, are a weaker record than ones the server saw arrive. They are
-- kept as track, not judged.

create or replace function public.record_buffered_positions(
  p_vehicle_id uuid,
  p_points     jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted integer := 0;
  p        jsonb;
  fixed_at timestamptz;
begin
  if not exists (
    select 1 from public.vehicles v
     where v.id = p_vehicle_id and v.owner = (select auth.uid())
  ) then
    raise exception 'Not your vehicle.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_points) <> 'array' then
    raise exception 'Expected a list of positions.' using errcode = '22023';
  end if;
  -- The app sends in batches; this bounds what one call can do.
  if jsonb_array_length(p_points) > 500 then
    raise exception 'At most 500 positions per call.' using errcode = '22023';
  end if;

  for p in select * from jsonb_array_elements(p_points)
  loop
    -- Each point on its own: one malformed point is skipped, not allowed to
    -- throw away the whole batch.
    begin
      fixed_at := (p ->> 'recorded_at')::timestamptz;

      -- Skip anything a live position would have been refused for, anything
      -- from the future (a little clock skew allowed), and anything too old
      -- to be a recent outage rather than something else.
      continue when fixed_at is null
        or fixed_at > now() + interval '1 minute'
        or fixed_at < now() - interval '12 hours'
        or jsonb_typeof(p -> 'lat') <> 'number'
        or jsonb_typeof(p -> 'lng') <> 'number'
        or (p ->> 'lat')::double precision not between -90 and 90
        or (p ->> 'lng')::double precision not between -180 and 180
        or coalesce((p ->> 'speed')::real, 0) not between 0 and 500
        or coalesce((p ->> 'heading')::real, 0) not between 0 and 360;

      -- Sent twice after a flaky reconnect? Kept once.
      continue when exists (
        select 1 from public.position_history h
         where h.vehicle_id = p_vehicle_id and h.recorded_at = fixed_at
      );

      insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
      values (
        p_vehicle_id,
        (p ->> 'lat')::double precision,
        (p ->> 'lng')::double precision,
        coalesce((p ->> 'speed')::real, 0),
        coalesce((p ->> 'heading')::real, 0),
        fixed_at
      );
      accepted := accepted + 1;
    exception when others then
      continue;
    end;
  end loop;

  return accepted;
end;
$$;

revoke execute on function public.record_buffered_positions(uuid, jsonb) from public, anon;
grant execute on function public.record_buffered_positions(uuid, jsonb) to authenticated;
