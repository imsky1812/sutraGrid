-- Granting emergency authorization from the operator console.
--
-- Until now the flag could only be set in the SQL editor, because
-- block_emergency_escalation refuses any change made by the `authenticated`
-- role - which is what stops a driver promoting their own vehicle. That rule
-- stays exactly as it is; operators go through the function below, which runs
-- as the owner, checks operator membership itself, and records who granted
-- what. A grant that nobody is accountable for would be worthless to an
-- authority reviewing the system.

create table public.emergency_grants (
  id            bigint generated always as identity primary key,
  vehicle_id    uuid not null references public.vehicles (id) on delete cascade,
  granted_by    uuid not null references auth.users (id) on delete cascade,
  authorized    boolean not null,
  -- The type set alongside the grant, when one was given.
  vehicle_type  text,
  at            timestamptz not null default now()
);

create index emergency_grants_vehicle_idx on public.emergency_grants (vehicle_id, at desc);

alter table public.emergency_grants enable row level security;

-- Readable by operators, written only by the function below.
create policy emergency_grants_select_operator on public.emergency_grants
  for select to authenticated using (public.is_operator());

create or replace function public.set_emergency_authorization(
  p_vehicle_id   uuid,
  p_authorized   boolean,
  p_vehicle_type text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not public.is_operator() then
    raise exception 'Only an operator may change emergency authorization.'
      using errcode = '42501';
  end if;

  if p_vehicle_type is not null
     and p_vehicle_type not in ('NORMAL', 'AMBULANCE', 'POLICE', 'FIRE') then
    raise exception 'Unknown vehicle type: %', p_vehicle_type using errcode = '22023';
  end if;

  update public.vehicles
     set is_emergency_authorized = p_authorized,
         vehicle_type = coalesce(p_vehicle_type, vehicle_type)
   where id = p_vehicle_id;

  if not found then
    raise exception 'No such vehicle: %', p_vehicle_id using errcode = 'P0002';
  end if;

  insert into public.emergency_grants (vehicle_id, granted_by, authorized, vehicle_type)
  values (p_vehicle_id, caller, p_authorized, p_vehicle_type);
end;
$$;

revoke execute on function public.set_emergency_authorization(uuid, boolean, text)
  from public, anon;
grant execute on function public.set_emergency_authorization(uuid, boolean, text)
  to authenticated;
