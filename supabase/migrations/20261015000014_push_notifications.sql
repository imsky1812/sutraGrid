-- Push notifications, so an alert reaches a phone whose app is closed.
--
-- Until now every alert travelled over Realtime and was turned into a
-- notification by the app itself. That works while the app is running,
-- including in the background, and not at all once it has been swiped away:
-- the give-way warning meant to clear a road for an ambulance simply never
-- arrived. Emergency alerts expire in minutes, so by the next launch they were
-- already gone. This closes that gap.
--
-- The path: an alert insert queues an HTTP call through pg_net to the `notify`
-- Edge Function, which claims the alert here, pushes it through Expo to every
-- device registered to the addressed vehicle, and forgets devices Expo reports
-- as uninstalled.
--
-- Push is always sent, even to a phone that is open and will also get the
-- alert over Realtime. Realtime has been seen to die silently (the console had
-- that bug), and a duplicate beep is a far smaller failure than a missed
-- give-way warning. The phone collapses the two into one notification.

-- ---------------------------------------------------------------------------
-- Which device is in which vehicle.
-- ---------------------------------------------------------------------------

create table public.device_tokens (
  -- Expo's opaque address for one install of the app on one phone.
  token       text primary key
              check (token ~ '^ExponentPushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- The vehicle this phone is currently driving. Alerts addressed to a vehicle
  -- go to the phone in it, not to every phone the owner has.
  vehicle_id  uuid references public.vehicles (id) on delete cascade,
  platform    text not null default 'android' check (platform in ('android', 'ios')),
  updated_at  timestamptz not null default now()
);

create index device_tokens_vehicle_idx on public.device_tokens (vehicle_id);
create index device_tokens_user_idx on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

-- A driver can see and remove their own devices. Writes go through the
-- function below, because a device moving between accounts has to be able to
-- take its token with it, which a row policy cannot express safely.
create policy device_tokens_select_own on public.device_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy device_tokens_delete_own on public.device_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

/**
 * Point this phone at a vehicle the caller owns.
 *
 * Holding the token is what proves the device: Expo only gives it to the app
 * running on that phone. So a phone that signs in as somebody else takes its
 * token with it, rather than going on receiving the previous owner's alerts.
 */
create or replace function public.register_push_token(
  p_token      text,
  p_vehicle_id uuid,
  p_platform   text default 'android'
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.vehicles v where v.id = p_vehicle_id and v.owner = caller
  ) then
    raise exception 'Not your vehicle.' using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^ExponentPushToken\[[A-Za-z0-9_-]{10,200}\]$' then
    raise exception 'Not an Expo push token.' using errcode = '22023';
  end if;

  if coalesce(p_platform, 'android') not in ('android', 'ios') then
    raise exception 'Unknown platform: %', p_platform using errcode = '22023';
  end if;

  insert into public.device_tokens (token, user_id, vehicle_id, platform, updated_at)
  values (p_token, caller, p_vehicle_id, coalesce(p_platform, 'android'), now())
  on conflict (token) do update
     set user_id    = excluded.user_id,
         vehicle_id = excluded.vehicle_id,
         platform   = excluded.platform,
         updated_at = now();
end;
$$;

revoke execute on function public.register_push_token(text, uuid, text) from public, anon;
grant execute on function public.register_push_token(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Claiming an alert for delivery.
-- ---------------------------------------------------------------------------

-- Set once, by the first delivery attempt. It is what makes `notify` safe to
-- call more than once: a replayed or duplicated request finds it already set
-- and sends nothing.
alter table public.alerts add column pushed_at timestamptz;

/**
 * Mark an alert as being pushed and return who to push it to.
 *
 * Returns nothing if the alert does not exist or was already claimed. An
 * expired alert is claimed but returns no devices: a give-way warning that
 * arrives ten minutes late is worse than none, because it is wrong.
 */
create or replace function public.claim_alert_push(p_alert_id bigint)
returns table (
  alert_id   bigint,
  category   text,
  severity   text,
  message    text,
  expires_at timestamptz,
  tokens     text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.alerts%rowtype;
begin
  update public.alerts a
     set pushed_at = now()
   where a.id = p_alert_id and a.pushed_at is null
  returning a.* into claimed;

  if not found then
    return;
  end if;

  return query
  select
    claimed.id,
    claimed.category,
    claimed.severity,
    claimed.message,
    claimed.expires_at,
    case
      when claimed.expires_at <= now() then array[]::text[]
      else coalesce(
        (
          select array_agg(d.token order by d.updated_at desc)
          from public.device_tokens d
          -- A broadcast goes to every registered device; an addressed alert
          -- only to the phone currently in that vehicle.
          where claimed.vehicle_id is null or d.vehicle_id = claimed.vehicle_id
        ),
        array[]::text[]
      )
    end;
end;
$$;

/** Expo says these devices uninstalled the app or revoked notifications. */
create or replace function public.forget_push_tokens(p_tokens text[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.device_tokens where token = any (p_tokens) returning 1
  )
  select count(*)::integer from gone;
$$;

-- Server only. Neither is something a phone should be able to call: one would
-- let a client mark someone else's alert as delivered, the other would let it
-- unregister someone else's phone.
revoke execute on function public.claim_alert_push(bigint) from public, anon, authenticated;
revoke execute on function public.forget_push_tokens(text[]) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_alert_push(bigint) to service_role;
    grant execute on function public.forget_push_tokens(text[]) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Firing it.
-- ---------------------------------------------------------------------------

-- pg_net makes the HTTP call after the alert commits, from a background
-- worker, so a slow push service never slows down the insert. Guarded because
-- the test harness runs plain Postgres, where it does not exist.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end
$$;

/**
 * Ask the notify function to push this alert.
 *
 * Reads the function's address and key from Vault rather than from this file,
 * so the migration carries no project-specific values. If anything is missing
 * - no pg_net, no secrets, an error from either - it does nothing: an alert
 * must never fail to save because its push could not be requested.
 */
create or replace function public.request_alert_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  api_key  text;
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return null;
  end if;

  execute $q$
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'sutra_project_url'),
      (select decrypted_secret from vault.decrypted_secrets where name = 'sutra_push_key')
  $q$ into base_url, api_key;

  if base_url is null or api_key is null then
    raise warning 'push not configured: missing vault secrets';
    return null;
  end if;

  execute $q$
    select net.http_post(
      url := $1,
      body := $2,
      headers := $3,
      timeout_milliseconds := 10000
    )
  $q$
  using
    base_url || '/functions/v1/notify',
    jsonb_build_object('alert_id', new.id),
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key
    );

  return null;
exception when others then
  raise warning 'push request for alert % failed: %', new.id, sqlerrm;
  return null;
end;
$$;

revoke execute on function public.request_alert_push() from public, anon, authenticated;

create trigger alerts_request_push
  after insert on public.alerts
  for each row execute function public.request_alert_push();

-- Devices belong to people, so they go when the account does (cascade above),
-- and stale ones are cleared by Expo's DeviceNotRegistered reports. Nothing
-- else to prune.
