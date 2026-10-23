-- Named-device presence and manual assignment for the shared LeadKing queue.
-- Run after 001_shared_lead_queue.sql in the Supabase SQL editor.

create table if not exists public.leadking_workers (
  owner_id uuid not null references auth.users(id) on delete cascade,
  worker_id text not null,
  display_name text not null,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (owner_id, worker_id)
);

alter table public.leadking_work_items
  add column if not exists assigned_worker_id text;

alter table public.leadking_workers enable row level security;
revoke all on public.leadking_workers from anon, authenticated;
grant select on public.leadking_workers to authenticated;
drop policy if exists leadking_workers_select_own on public.leadking_workers;
create policy leadking_workers_select_own on public.leadking_workers
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.leadking_register_worker(p_worker_id text, p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  if length(coalesce(p_worker_id,'')) < 8 or length(p_worker_id) > 100 then raise exception 'Invalid worker id'; end if;
  if length(trim(coalesce(p_display_name,''))) < 1 or length(p_display_name) > 80 then raise exception 'Enter a device name between 1 and 80 characters'; end if;
  insert into public.leadking_workers(owner_id, worker_id, display_name, last_seen)
  values(v_owner, p_worker_id, trim(p_display_name), now())
  on conflict(owner_id, worker_id) do update
    set display_name=excluded.display_name, last_seen=now();
end $$;

create or replace function public.leadking_list_workers()
returns table(worker_id text, display_name text, last_seen timestamptz, online boolean)
language sql stable security invoker set search_path = '' as $$
  select w.worker_id, w.display_name, w.last_seen, w.last_seen > now() - interval '2 minutes'
  from public.leadking_workers w
  where w.owner_id=(select auth.uid())
  order by w.display_name, w.worker_id
$$;

create or replace function public.leadking_available_cities()
returns table(city text, available bigint)
language sql stable security invoker set search_path = '' as $$
  select coalesce(nullif(trim(q.payload->>'city'),''),'__unspecified__'), count(*)
  from public.leadking_work_items q
  where q.owner_id=(select auth.uid())
    and q.assigned_worker_id is null
    and (q.work_state='pending' or (q.work_state='leased' and q.lease_until <= now()))
    and coalesce(q.payload->>'status','')='pending'
    and coalesce(q.payload->>'website','') <> ''
  group by 1
  order by 1
$$;

create or replace function public.leadking_assign_work(
  p_worker_id text,
  p_city text default null,
  p_limit integer default 100
)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_count integer;
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  if not exists(select 1 from public.leadking_workers w where w.owner_id=v_owner and w.worker_id=p_worker_id) then
    raise exception 'Register the target device first';
  end if;
  if p_city is not null and p_city <> '__unspecified__'
     and length(trim(p_city)) > 120 then raise exception 'City filter is too long'; end if;
  with candidates as (
    select q.owner_id, q.source_identity
    from public.leadking_work_items q
    where q.owner_id=v_owner
      and q.assigned_worker_id is null
      and (q.work_state='pending' or (q.work_state='leased' and q.lease_until <= now()))
      and coalesce(q.payload->>'status','')='pending'
      and coalesce(q.payload->>'website','') <> ''
      and (
        p_city is null
        or (p_city='__unspecified__' and nullif(trim(q.payload->>'city'),'') is null)
        or (p_city<>'__unspecified__' and lower(trim(q.payload->>'city'))=lower(trim(p_city)))
      )
    order by q.created_at, q.source_identity
    limit greatest(1, least(coalesce(p_limit,100), 5000))
    for update skip locked
  )
  update public.leadking_work_items q
    set assigned_worker_id=p_worker_id, updated_at=now()
  from candidates c
  where q.owner_id=c.owner_id and q.source_identity=c.source_identity;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.leadking_register_worker(text,text) from public, anon;
revoke all on function public.leadking_list_workers() from public, anon;
revoke all on function public.leadking_available_cities() from public, anon;
revoke all on function public.leadking_assign_work(text,text,integer) from public, anon;
grant execute on function public.leadking_register_worker(text,text) to authenticated;
grant execute on function public.leadking_list_workers() to authenticated;
grant execute on function public.leadking_available_cities() to authenticated;
grant execute on function public.leadking_assign_work(text,text,integer) to authenticated;

-- Replace the original claim function so targeted assignments can only be
-- claimed by the named computer; unassigned queue rows remain shared.
create or replace function public.leadking_claim_work(p_worker_id text, p_lease_seconds integer default 900)
returns table(source_identity text, lease_token uuid, lease_until timestamptz, payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Sign in required'; end if;
  if length(coalesce(p_worker_id,'')) < 8 or length(p_worker_id) > 100 then raise exception 'Invalid worker id'; end if;
  update public.leadking_workers w set last_seen=now()
    where w.owner_id=v_owner and w.worker_id=p_worker_id;
  return query
  with candidates as (
    select q.owner_id, q.source_identity
    from public.leadking_work_items q
    where q.owner_id = v_owner
      and (q.work_state='pending' or (q.work_state='leased' and q.lease_until <= now()))
      and (q.assigned_worker_id is null or q.assigned_worker_id=p_worker_id)
      and coalesce(q.payload->>'status','')='pending'
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

revoke all on function public.leadking_claim_work(text,integer) from public, anon;
grant execute on function public.leadking_claim_work(text,integer) to authenticated;
