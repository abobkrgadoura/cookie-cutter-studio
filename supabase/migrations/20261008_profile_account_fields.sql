-- Account fields edited from the full-screen Settings overlay.
-- Billing columns stay server-owned: a signed-in user cannot flip is_pro or plan_tier.

alter table public.profiles
  add column if not exists display_name text;

alter table public.profiles
  add column if not exists avatar_url text;

create or replace function public.protect_profile_billing()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'authenticated' then
    new.is_pro := old.is_pro;
    new.plan_tier := old.plan_tier;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_profile_billing on public.profiles;
create trigger protect_profile_billing
  before update on public.profiles
  for each row
  execute function public.protect_profile_billing();

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "Avatar images are publicly readable" on storage.objects;
create policy "Avatar images are publicly readable"
  on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

drop policy if exists "Users upload their own avatar" on storage.objects;
create policy "Users upload their own avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users update their own avatar" on storage.objects;
create policy "Users update their own avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
