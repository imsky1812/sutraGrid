-- Operators: authenticated users allowed to watch the whole fleet.
--
-- The previous migration granted select to a Postgres role named `operator`,
-- which nothing can actually reach: a browser using the anon key authenticates
-- as `anon`, and after signing in as `authenticated`. Neither is `operator`, so
-- the dashboard could subscribe to Realtime and receive nothing.
--
-- Membership is a table instead, checked against auth.uid(). An operator is
-- added deliberately by an administrator, exactly like emergency authorisation.

create table public.operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  label      text not null default 'Operator',
  created_at timestamptz not null default now()
);

alter table public.operators enable row level security;

-- An operator may confirm their own membership, which the dashboard uses to
-- decide whether to show the fleet or an access-denied screen. Nobody can add
-- themselves: there is no insert or update policy, so writes require an
-- administrator using the service role or the SQL editor.
create policy operators_read_self on public.operators
  for select using (user_id = (select auth.uid()));

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.operators o where o.user_id = (select auth.uid())
  )
$$;

grant execute on function public.is_operator() to authenticated;

-- Fleet-wide read for operators, alongside the existing owner-only policies.
-- Postgres ORs permissive policies together, so a driver keeps seeing their own
-- vehicles and an operator additionally sees everyone's.
create policy vehicles_select_operator_member on public.vehicles
  for select to authenticated using (public.is_operator());

create policy positions_select_operator_member on public.vehicle_positions
  for select to authenticated using (public.is_operator());

-- Realtime only delivers rows the subscriber is allowed to select, so the
-- policy above is what makes the live feed work rather than silently deliver
-- nothing.
alter table public.vehicles replica identity full;
alter table public.vehicle_positions replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.vehicles;
  end if;
end
$$;
