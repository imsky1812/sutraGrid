-- Retention.
--
-- position_history grows at roughly 1,200-3,600 rows per vehicle-hour at the
-- app's 1-3 second cadence, so it needs pruning or it will fill the database.
-- The windows below are set by what the product actually shows: the driver
-- console offers a week of history, so a month is generous; violations are the
-- record a driver is judged on, so they are kept far longer.
--
-- The prune is a plain function so it can be tested and run by hand. Scheduling
-- is separate and guarded, because pg_cron exists on Supabase but not in the
-- PGlite harness the tests run against.

create table public.retention_policy (
  table_name  text primary key,
  keep_days   integer not null check (keep_days > 0)
);

insert into public.retention_policy (table_name, keep_days) values
  ('position_history', 30),
  ('violations', 365),
  ('alerts', 30);

alter table public.retention_policy enable row level security;
create policy retention_read_all on public.retention_policy
  for select to authenticated using (true);

create or replace function public.prune_old_data()
returns table (pruned_table text, removed bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  history_days   integer := (select keep_days from public.retention_policy where table_name = 'position_history');
  violation_days integer := (select keep_days from public.retention_policy where table_name = 'violations');
  alert_days     integer := (select keep_days from public.retention_policy where table_name = 'alerts');
  n bigint;
begin
  delete from public.position_history
   where recorded_at < now() - make_interval(days => coalesce(history_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'position_history'; removed := n; return next;

  -- Only closed violations age out. An episode still open belongs to a vehicle
  -- that is speeding right now, however old the row is.
  delete from public.violations
   where cleared_at is not null
     and occurred_at < now() - make_interval(days => coalesce(violation_days, 365));
  get diagnostics n = row_count;
  pruned_table := 'violations'; removed := n; return next;

  delete from public.alerts
   where created_at < now() - make_interval(days => coalesce(alert_days, 30));
  get diagnostics n = row_count;
  pruned_table := 'alerts'; removed := n; return next;
end;
$$;

-- Scheduling is best-effort: the function is the contract, the cron job is a
-- convenience. Without pg_cron the prune can still be run manually or from CI.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('sutra-prune', '17 3 * * *', 'select public.prune_old_data()');
  end if;
exception when others then
  raise notice 'pg_cron unavailable, skipping schedule: %', sqlerrm;
end
$$;
