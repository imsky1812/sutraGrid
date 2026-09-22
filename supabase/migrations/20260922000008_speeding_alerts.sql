-- Tell the driver the moment they start speeding.
--
-- A violation used to be visible only to an operator reading history later. Now
-- opening a speeding episode also raises a RULE alert addressed to that
-- vehicle, which the app turns into a beep and a notification. Because it rides
-- the existing episode logic, a driver hears it once per episode rather than on
-- every frame.

-- System alerts have no human author. The insert policy still requires a
-- client's alert to carry its own uid, and a null never equals auth.uid(), so
-- only server-side code can write an authorless alert.
alter table public.alerts alter column created_by drop not null;

create or replace function public.alert_on_speed_violation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
  values (
    null,
    new.vehicle_id,
    'RULE',
    'WARNING',
    format('Overspeeding: %s km/h in a %s km/h zone. Slow down.',
           round(new.speed::numeric), round(new.speed_limit::numeric)),
    -- A speeding warning is stale within minutes.
    now() + interval '10 minutes'
  );
  return new;
end;
$$;

create trigger violations_alert_driver
  after insert on public.violations
  for each row execute function public.alert_on_speed_violation();
