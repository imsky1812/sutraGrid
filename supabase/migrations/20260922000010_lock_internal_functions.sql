-- Close internal functions to the REST API.
--
-- Every function in the public schema is exposed at /rest/v1/rpc/<name>, and
-- Postgres grants EXECUTE to PUBLIC by default. These are SECURITY DEFINER, so
-- any visitor could run them with the owner's rights: prune data on demand,
-- or re-run the operator invite sync. Triggers and pg_cron run as the owner
-- and are unaffected.
--
-- Deliberately left executable by signed-in users:
--   start_corridor, end_corridor  - the corridor API
--   is_operator, can_see_corridor - called by RLS policies as the requester
--   speed_limit_kmh               - a public setting, readable anyway

revoke execute on function public.prune_old_data() from public, anon, authenticated;
revoke execute on function public.sync_operator_invites() from public, anon, authenticated;

-- Trigger functions refuse direct calls anyway; revoking keeps them out of the
-- API surface altogether.
revoke execute on function public.advance_corridor() from public, anon, authenticated;
revoke execute on function public.alert_on_speed_violation() from public, anon, authenticated;
revoke execute on function public.record_position_history() from public, anon, authenticated;
revoke execute on function public.record_speed_violation() from public, anon, authenticated;
revoke execute on function public.grant_invited_operator() from public, anon, authenticated;

-- Nobody signed out needs these.
revoke execute on function public.is_operator() from public, anon;
revoke execute on function public.can_see_corridor(uuid) from public, anon;
grant execute on function public.is_operator() to authenticated;
grant execute on function public.can_see_corridor(uuid) to authenticated;
