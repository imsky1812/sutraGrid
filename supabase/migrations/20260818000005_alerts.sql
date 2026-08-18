-- Alerts sent by an operator to one vehicle or to the whole fleet.
--
-- A null vehicle_id is a broadcast. Delivery rides Supabase Realtime: the app
-- subscribes to this table, and RLS decides which rows it is allowed to see, so
-- a driver receives their own alerts and broadcasts but never another
-- vehicle's.

create table public.alerts (
  id         bigint generated always as identity primary key,
  created_by uuid not null references auth.users (id) on delete cascade,
  -- null means every vehicle.
  vehicle_id uuid references public.vehicles (id) on delete cascade,
  category   text not null default 'MESSAGE'
               check (category in ('CONGESTION', 'RULE', 'HAZARD', 'MESSAGE')),
  severity   text not null default 'INFO'
               check (severity in ('INFO', 'WARNING', 'CRITICAL')),
  message    text not null check (char_length(message) between 1 and 300),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);

create index alerts_vehicle_time_idx on public.alerts (vehicle_id, created_at desc);
create index alerts_created_idx on public.alerts (created_at desc);

alter table public.alerts enable row level security;

-- Only an operator may raise an alert, and only in their own name.
create policy alerts_insert_operator on public.alerts
  for insert to authenticated
  with check (public.is_operator() and created_by = (select auth.uid()));

create policy alerts_select_operator on public.alerts
  for select to authenticated using (public.is_operator());

-- A driver sees broadcasts and alerts addressed to a vehicle they own.
create policy alerts_select_addressed on public.alerts
  for select to authenticated using (
    vehicle_id is null
    or exists (select 1 from public.vehicles v
                where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

-- Acknowledgements, so an operator can see an alert actually landed.
create table public.alert_receipts (
  alert_id        bigint not null references public.alerts (id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (alert_id, vehicle_id)
);

alter table public.alert_receipts enable row level security;

create policy receipts_insert_own on public.alert_receipts
  for insert to authenticated
  with check (
    exists (select 1 from public.vehicles v
             where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

create policy receipts_select_own on public.alert_receipts
  for select to authenticated using (
    public.is_operator()
    or exists (select 1 from public.vehicles v
                where v.id = vehicle_id and v.owner = (select auth.uid()))
  );

alter table public.alerts replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.alerts;
  end if;
end
$$;
