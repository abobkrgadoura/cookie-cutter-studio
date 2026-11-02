-- Profiles linked to auth.users. is_pro is the billing flag the Paymob webhook sets.
-- plan_tier stays in sync because the app already reads profiles.plan_tier ('free' | 'pro').

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  is_pro boolean not null default false,
  plan_tier text not null default 'free',
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists is_pro boolean not null default false;

alter table public.profiles
  add column if not exists plan_tier text not null default 'free';

alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Existing client fallback inserts a free row. It cannot grant Pro.
drop policy if exists "Users can insert own free profile" on public.profiles;
create policy "Users can insert own free profile"
  on public.profiles
  for insert
  to authenticated
  with check (
    auth.uid() = id
    and is_pro = false
    and plan_tier = 'free'
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, is_pro, plan_tier)
  values (new.id, false, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

insert into public.profiles (id, is_pro, plan_tier)
select id, false, 'free'
from auth.users
on conflict (id) do nothing;

update public.profiles
set is_pro = true
where plan_tier = 'pro'
  and is_pro is distinct from true;
