-- Move pg_net out of the public schema.
--
-- Migration 000014 created it without naming a schema, so it landed in
-- `public`, and the security advisor flagged it (extension_in_public): anything
-- in `public` is part of the exposed API surface. Supabase keeps extensions in
-- `extensions`. pg_net's functions live in its own `net` schema either way, and
-- request_alert_push looks them up there by name, so nothing else changes.
--
-- Dropping it also drops its queue and response tables, which hold only the
-- delivery log of past requests.

do $$
begin
  if exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end
$$;
