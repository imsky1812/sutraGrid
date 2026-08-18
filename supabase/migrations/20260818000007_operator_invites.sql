-- Operator provisioning by email invite.
--
-- operators references auth.users, so an account has to exist before it can be
-- promoted. That made granting access a two-step dance: the person signs up,
-- then an administrator runs SQL. An invite list closes the gap - the address is
-- allowed ahead of time and the grant happens on signup.
--
-- Self-promotion is still impossible: the invite table is readable by nobody
-- through the API and writable only by the service role or the SQL editor.

create table public.operator_invites (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.operator_invites enable row level security;
-- Deliberately no policies: unreachable through PostgREST for any signed-in
-- user. The trigger below runs as definer and bypasses RLS.

create or replace function public.grant_invited_operator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.operator_invites i
     where lower(i.email) = lower(new.email)
  ) then
    insert into public.operators (user_id, label)
    values (new.id, coalesce((select note from public.operator_invites
                               where lower(email) = lower(new.email)), 'Operator'))
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger auth_user_grant_operator
  after insert on auth.users
  for each row execute function public.grant_invited_operator();

-- Promote anyone already signed up whose address is invited, so the invite
-- works regardless of which came first.
create or replace function public.sync_operator_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  granted integer;
begin
  insert into public.operators (user_id, label)
  select u.id, coalesce(i.note, 'Operator')
    from auth.users u
    join public.operator_invites i on lower(i.email) = lower(u.email)
   on conflict (user_id) do nothing;
  get diagnostics granted = row_count;
  return granted;
end;
$$;
