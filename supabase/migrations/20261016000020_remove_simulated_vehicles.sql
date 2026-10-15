-- Let the simulator clean up after itself, without letting anyone erase a
-- real vehicle's record.
--
-- Found by running the simulator against the live project: its clean-up
-- deleted from vehicles, but there is no delete policy on vehicles, so the
-- delete silently matched nothing and five simulated cars were left behind.
--
-- A general "drivers may delete their own vehicle" policy would be the wrong
-- fix. Deleting a vehicle cascades to its history, violations and events, so
-- it would let any driver wipe their own record - the opposite of what a
-- system offered to traffic authorities must guarantee. Instead: an operator
-- may remove simulated vehicles they registered, and nothing else.

create or replace function public.remove_simulated_vehicles()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  if not public.is_operator() then
    raise exception 'Only an operator can remove simulated vehicles.' using errcode = '42501';
  end if;

  delete from public.vehicles
   where owner = (select auth.uid())
     and vehicle_number like 'SIM %'
     and driver_name like 'Simulated%';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.remove_simulated_vehicles() from public, anon;
grant execute on function public.remove_simulated_vehicles() to authenticated;
