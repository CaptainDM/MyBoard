-- Little Board cloud sync — run this in the Supabase SQL Editor.
-- Safe to run alongside another app in the same Supabase project.
-- No service-role key is ever used in the browser.

create table if not exists public.little_board_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  constraint little_board_data_object check (jsonb_typeof(data) = 'object')
);

alter table public.little_board_state enable row level security;

-- Each signed-in user can see and edit ONLY their own board.
drop policy if exists "Little Board select own" on public.little_board_state;
create policy "Little Board select own" on public.little_board_state
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Little Board insert own" on public.little_board_state;
create policy "Little Board insert own" on public.little_board_state
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Little Board update own" on public.little_board_state;
create policy "Little Board update own" on public.little_board_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No DELETE grant/policy: signing out or clearing cards cannot delete board rows.
revoke all on public.little_board_state from anon;
grant select, insert, update on public.little_board_state to authenticated;

-- Tell Supabase Realtime about the table (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'little_board_state'
  ) then
    alter publication supabase_realtime add table public.little_board_state;
  end if;
end $$;
