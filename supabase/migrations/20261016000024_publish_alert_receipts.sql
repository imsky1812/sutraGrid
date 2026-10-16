-- Delivery status for alerts, live in the console.
--
-- The app has written an alert_receipts row since alerts were introduced -
-- the moment an alert reaches an open app - but the table was never in the
-- Realtime publication, so the operator who sent the alert could not see it
-- land without reloading.
--
-- receipts_select_own already lets an operator read every receipt and a
-- driver only their own vehicle's, and Realtime applies exactly those
-- policies, so publishing the table widens nothing.
--
-- A receipt means "the app had it open and received it". An alert that
-- reached a closed app by push leaves none, so the console words a missing
-- receipt as "not yet seen in the app", never as "not delivered".

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'alert_receipts'
     ) then
    alter publication supabase_realtime add table public.alert_receipts;
  end if;
end
$$;
