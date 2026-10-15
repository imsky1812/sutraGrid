-- Speeding violations never reached the console live.
--
-- The console has subscribed to inserts on public.violations since it was
-- written, but the table was never added to the Realtime publication, so that
-- handler has never once fired: the speeding count and the event entry only
-- appeared after a reload, which read them back over REST.
--
-- The RLS on violations already says who may see them - the vehicle's owner,
-- or an operator - and Realtime applies exactly those policies, so publishing
-- the table widens nothing.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'violations'
     ) then
    alter publication supabase_realtime add table public.violations;
  end if;
end
$$;

-- An episode is updated as the peak speed rises and closed when it ends, so
-- the old row has to travel with the change for those to be usable later.
alter table public.violations replica identity full;
