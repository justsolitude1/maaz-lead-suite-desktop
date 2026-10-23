-- LeadKing shared queue. Each Supabase Auth user gets a private queue.
-- Run this migration in the Supabase SQL editor for the project.
create table if not exists public.leadking_work_items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_identity text not null,
  payload jsonb not null,
  work_state text not null default 'pending' check (work_state in ('pending','leased','complete')),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, source_identity)
);

create index if not exists leadking_work_claim_idx
  on public.leadking_work_items (owner_id, work_state, lease_until, created_at);

alter table public.leadking_work_items enable row level security;
revoke all on public.leadking_work_items from anon, authenticated;
grant select, insert on public.leadking_work_items to authenticated;

drop policy if exists leadking_select_own on public.leadking_work_items;
create policy leadking_select_own on public.leadking_work_items
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists leadking_insert_own on public.leadking_work_items;
create policy leadking_insert_own on public.leadking_work_items
  for insert to authenticated with check (owner_id = (select auth.uid()));

create or replace function public.leadking_claim_work(p_worker_id text, p_lease_seconds integer default 900)
returns table(source_identity text, lease_token uuid, lease_until timestamptz, payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  if length(coalesce(p_worker_id,'')) < 8 or length(p_worker_id) > 100 then raise exception 'Invalid worker id'; end if;
  return query
  with candidates as (
    select q.owner_id, q.source_identity
    from public.leadking_work_items q
    where q.owner_id = v_owner
      and (q.work_state = 'pending' or (q.work_state = 'leased' and q.lease_until < now()))
      and coalesce(q.payload->>'status','') = 'pending'
      and coalesce(q.payload->>'website','') <> ''
    order by q.created_at, q.source_identity
    limit 1
    for update skip locked
  ), claimed as (
    update public.leadking_work_items q
    set work_state='leased', lease_owner=p_worker_id, lease_token=gen_random_uuid(),
        lease_until=now() + make_interval(secs => greatest(120, least(coalesce(p_lease_seconds,900), 3600))), updated_at=now()
    from candidates c where q.owner_id=c.owner_id and q.source_identity=c.source_identity
    returning q.source_identity, q.lease_token, q.lease_until, q.payload
  ) select c.source_identity,c.lease_token,c.lease_until,c.payload from claimed c;
end $$;

create or replace function public.leadking_renew_work(p_source_identity text, p_lease_token uuid, p_lease_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_count integer;
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  update public.leadking_work_items q
  set lease_until=now() + make_interval(secs => greatest(120, least(coalesce(p_lease_seconds,900), 3600))), updated_at=now()
  where q.owner_id=v_owner and q.source_identity=p_source_identity and q.work_state='leased'
    and q.lease_token=p_lease_token and q.lease_until > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

create or replace function public.leadking_complete_work(p_source_identity text, p_lease_token uuid, p_result jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_count integer;
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  update public.leadking_work_items q
  set work_state='complete', result=p_result, lease_owner=null, lease_token=null, lease_until=null, updated_at=now()
  where q.owner_id=v_owner and q.source_identity=p_source_identity and q.work_state='leased'
    and q.lease_token=p_lease_token and q.lease_until > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

create or replace function public.leadking_release_work(p_source_identity text, p_lease_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_count integer;
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  update public.leadking_work_items q
  set work_state='pending', lease_owner=null, lease_token=null, lease_until=null, updated_at=now()
  where q.owner_id=v_owner and q.source_identity=p_source_identity and q.work_state='leased'
    and q.lease_token=p_lease_token and q.lease_until > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

create or replace function public.leadking_queue_counts()
returns table(pending bigint, leased bigint, complete bigint)
language sql stable security invoker set search_path = '' as $$
  select count(*) filter (where work_state='pending' or (work_state='leased' and lease_until <= now())),
         count(*) filter (where work_state='leased' and lease_until > now()),
         count(*) filter (where work_state='complete')
  from public.leadking_work_items where owner_id=(select auth.uid())
$$;

revoke all on function public.leadking_claim_work(text,integer) from public, anon;
revoke all on function public.leadking_renew_work(text,uuid,integer) from public, anon;
revoke all on function public.leadking_complete_work(text,uuid,jsonb) from public, anon;
revoke all on function public.leadking_release_work(text,uuid) from public, anon;
revoke all on function public.leadking_queue_counts() from public, anon;
grant execute on function public.leadking_claim_work(text,integer) to authenticated;
grant execute on function public.leadking_renew_work(text,uuid,integer) to authenticated;
grant execute on function public.leadking_complete_work(text,uuid,jsonb) to authenticated;
grant execute on function public.leadking_release_work(text,uuid) to authenticated;
grant execute on function public.leadking_queue_counts() to authenticated;
