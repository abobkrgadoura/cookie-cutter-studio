-- Hardening pass from the live database review.
-- Covers: profile updates + server-owned billing columns, cascade deletes,
-- avatar storage ownership, handle_new_user exposure, designs index/policies,
-- billing flag consistency, and per-row auth.uid() re-evaluation in RLS.

-- ---------------------------------------------------------------------------
-- 1. profiles: allow users to update their own profile, but only safe columns.
--    is_pro / plan_tier stay writable only by service_role (Paymob webhook).
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists display_name text;

alter table public.profiles
  add column if not exists avatar_url text;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can insert own free profile" on public.profiles;
create policy "Users can insert own free profile"
  on public.profiles
  for insert
  to authenticated
  with check (
    (select auth.uid()) = id
    and is_pro = false
    and plan_tier = 'free'
  );

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;
grant update (display_name, avatar_url, updated_at)
  on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Cascade deletes so removing an auth user does not fail on child rows.
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users (id) on delete cascade;

alter table public.designs drop constraint if exists designs_user_id_fkey;
alter table public.designs
  add constraint designs_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 3. handle_new_user is trigger-only; do not expose it as an RPC endpoint.
-- ---------------------------------------------------------------------------

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. designs: index the owner lookup + sort, and wrap auth.uid() in policies.
--    with check on UPDATE stops a user re-assigning a design to someone else.
-- ---------------------------------------------------------------------------

create index if not exists designs_user_created_idx
  on public.designs (user_id, created_at desc);

drop policy if exists "Users can view their own designs" on public.designs;
create policy "Users can view their own designs"
  on public.designs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own designs" on public.designs;
create policy "Users can insert their own designs"
  on public.designs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own designs" on public.designs;
create policy "Users can update their own designs"
  on public.designs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own designs" on public.designs;
create policy "Users can delete their own designs"
  on public.designs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 5. Billing flags must describe one state.
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_plan_tier_chk;
alter table public.profiles
  add constraint profiles_plan_tier_chk
  check (plan_tier in ('free', 'pro'));

alter table public.profiles drop constraint if exists profiles_billing_in_sync_chk;
alter table public.profiles
  add constraint profiles_billing_in_sync_chk
  check ((plan_tier = 'pro') = is_pro);

-- ---------------------------------------------------------------------------
-- 6. avatars bucket: owner-scoped policies (first folder = user id).
--    Upsert needs INSERT + SELECT + UPDATE. The bucket stays public so
--    getPublicUrl keeps working.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "Allow users to upload avatars 1oj01fe_0" on storage.objects;
drop policy if exists "Avatar images are publicly readable" on storage.objects;

drop policy if exists "Users read their own avatar" on storage.objects;
create policy "Users read their own avatar"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users upload their own avatar" on storage.objects;
create policy "Users upload their own avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users update their own avatar" on storage.objects;
create policy "Users update their own avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users delete their own avatar" on storage.objects;
create policy "Users delete their own avatar"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
