-- Vehicles owned by authenticated drivers.
--
-- The important property here is that emergency privilege is data an
-- administrator sets, not something a driver can assert. The previous design
-- used a shared EMERGENCY_CODES secret, which any driver who learned it could
-- reuse to stream as an ambulance.

create table public.vehicles (
  id                      uuid primary key default gen_random_uuid(),
  owner                   uuid not null references auth.users (id) on delete cascade,
  vehicle_number          text not null unique,
  driver_name             text not null,
  vehicle_type            text not null default 'NORMAL'
                            check (vehicle_type in ('NORMAL','AMBULANCE','POLICE','FIRE')),
  is_emergency_authorized boolean not null default false,
  created_at              timestamptz not null default now()
);

create index vehicles_owner_idx on public.vehicles (owner);

alter table public.vehicles enable row level security;

create policy vehicles_select_own on public.vehicles
  for select using (owner = (select auth.uid()));

create policy vehicles_insert_own on public.vehicles
  for insert with check (owner = (select auth.uid()));

create policy vehicles_update_own on public.vehicles
  for update using (owner = (select auth.uid()))
             with check (owner = (select auth.uid()));

-- Postgres has no column-level RLS on UPDATE, so vehicles_update_own would
-- happily let a driver flip their own is_emergency_authorized to true. This
-- trigger is what actually prevents self-escalation.
--
-- The check is on current_user rather than the `role` setting: an administrator
-- working in the Supabase SQL editor runs as `postgres`, where `role` reads as
-- 'none', and blocking them would make the privilege ungrantable.
create or replace function public.block_emergency_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_emergency_authorized is distinct from old.is_emergency_authorized
     and current_user in ('authenticated', 'anon') then
    raise exception 'is_emergency_authorized cannot be changed by this role'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger vehicles_block_escalation
  before update on public.vehicles
  for each row execute function public.block_emergency_escalation();
