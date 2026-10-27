-- Private cloud copies of crawler output. These records are separate from
-- leadking_work_items so result backups can never be claimed as new work.
create table if not exists public.leadking_crawl_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  record_key text not null,
  record_kind text not null check (record_kind in ('business_lead','therapist_research')),
  run_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, record_key)
);

create index if not exists leadking_crawl_records_owner_kind_idx
  on public.leadking_crawl_records (owner_id, record_kind, record_key);

alter table public.leadking_crawl_records enable row level security;
revoke all on public.leadking_crawl_records from anon, authenticated;
grant select, insert, update on public.leadking_crawl_records to authenticated;

drop policy if exists leadking_crawl_records_select_own on public.leadking_crawl_records;
create policy leadking_crawl_records_select_own on public.leadking_crawl_records
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists leadking_crawl_records_insert_own on public.leadking_crawl_records;
create policy leadking_crawl_records_insert_own on public.leadking_crawl_records
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists leadking_crawl_records_update_own on public.leadking_crawl_records;
create policy leadking_crawl_records_update_own on public.leadking_crawl_records
  for update to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
