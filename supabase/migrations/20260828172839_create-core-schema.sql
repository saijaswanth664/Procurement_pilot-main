-- ProcurementPilot core schema (AyuraNest).
-- Media stays on Cloudinary; Postgres stores URLs only, never binary blobs.
-- Roles live in public.profiles (not user_metadata). RLS helpers live in private.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to postgres, service_role, authenticated;

create type public.app_role as enum ('supplier', 'business_owner');
create type public.metric_source as enum ('synthetic', 'observed');
create type public.disruption_type as enum ('price', 'capacity', 'reliability');
create type public.decision_maker as enum ('agent', 'human');

create table public.suppliers (
  id bigint generated always as identity primary key,
  name text not null,
  category text not null,
  region text not null,
  moq numeric not null default 0 check (moq >= 0),
  max_capacity numeric not null check (max_capacity >= 0),
  active_since date not null
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null,
  supplier_id bigint references public.suppliers (id) on delete set null,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.supplier_metrics (
  supplier_id bigint not null references public.suppliers (id) on delete cascade,
  date date not null,
  price numeric not null check (price >= 0),
  defect_rate numeric not null check (defect_rate >= 0),
  lead_time_days numeric not null check (lead_time_days >= 0),
  capacity_used numeric not null check (capacity_used >= 0),
  source public.metric_source not null,
  primary key (supplier_id, date)
);

create table public.orders (
  id bigint generated always as identity primary key,
  business_id uuid not null references auth.users (id) on delete cascade,
  supplier_id bigint not null references public.suppliers (id) on delete restrict,
  sku text not null,
  qty_ordered numeric not null check (qty_ordered >= 0),
  qty_allocated numeric check (qty_allocated is null or qty_allocated >= 0),
  status text not null,
  created_at timestamptz not null default now()
);

create table public.batches (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  supplier_id bigint not null references public.suppliers (id) on delete restrict,
  photo_url text,
  vlm_description text,
  defect_flag boolean,
  defect_confidence numeric check (
    defect_confidence is null
    or (defect_confidence >= 0 and defect_confidence <= 1)
  ),
  reported_pdf_url text
);

create table public.messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null,
  sender_id uuid not null references auth.users (id) on delete cascade,
  sender_role public.app_role not null,
  body text,
  voice_url text,
  transcript text,
  mentions_supplement boolean not null default false,
  flagged_for_dashboard boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.disruptions (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers (id) on delete cascade,
  type public.disruption_type not null,
  magnitude numeric not null,
  triggered_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.strategies (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  risk_weight numeric not null,
  allocation_json jsonb not null default '{}'::jsonb,
  expected_cost numeric,
  expected_risk numeric,
  created_at timestamptz not null default now()
);

create table public.legal_docs (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers (id) on delete cascade,
  doc_url text,
  doc_type text not null,
  ai_summary text,
  flagged_issues_json jsonb,
  uploaded_at timestamptz not null default now()
);

create table public.decisions (
  id bigint generated always as identity primary key,
  related_entity_type text not null,
  related_entity_id bigint not null,
  decision_text text not null,
  reasoning text not null,
  made_by public.decision_maker not null,
  created_at timestamptz not null default now()
);

-- Foreign keys (Postgres does not index these automatically).
create index profiles_supplier_id_idx on public.profiles (supplier_id);
create index orders_business_id_idx on public.orders (business_id);
create index orders_supplier_id_idx on public.orders (supplier_id);
create index batches_order_id_idx on public.batches (order_id);
create index batches_supplier_id_idx on public.batches (supplier_id);
create index messages_sender_id_idx on public.messages (sender_id);
create index messages_thread_id_idx on public.messages (thread_id);
create index disruptions_supplier_id_idx on public.disruptions (supplier_id);
create index legal_docs_supplier_id_idx on public.legal_docs (supplier_id);
create index decisions_related_idx on public.decisions (related_entity_type, related_entity_id);

-- Timestamp / feed queries.
create index profiles_created_at_idx on public.profiles (created_at desc);
create index orders_created_at_idx on public.orders (created_at desc);
create index messages_created_at_idx on public.messages (created_at desc);
create index disruptions_triggered_at_idx on public.disruptions (triggered_at desc);
create index strategies_created_at_idx on public.strategies (created_at desc);
create index strategies_run_id_idx on public.strategies (run_id);
create index legal_docs_uploaded_at_idx on public.legal_docs (uploaded_at desc);
create index decisions_created_at_idx on public.decisions (created_at desc);

create index messages_flagged_created_at_idx
  on public.messages (created_at desc)
  where flagged_for_dashboard;

create index disruptions_open_idx
  on public.disruptions (supplier_id, triggered_at desc)
  where resolved_at is null;

create index suppliers_category_idx on public.suppliers (category);

create or replace function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid());
$$;

create or replace function private.is_business_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'business_owner'
  );
$$;

create or replace function private.current_supplier_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select p.supplier_id
  from public.profiles p
  where p.id = (select auth.uid());
$$;

create or replace function private.user_in_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages m
    where m.thread_id = p_thread_id
      and m.sender_id = (select auth.uid())
  );
$$;

revoke all on function private.current_app_role() from public, anon;
revoke all on function private.is_business_owner() from public, anon;
revoke all on function private.current_supplier_id() from public, anon;
revoke all on function private.user_in_thread(uuid) from public, anon;
grant execute on function private.current_app_role() to authenticated, service_role;
grant execute on function private.is_business_owner() to authenticated, service_role;
grant execute on function private.current_supplier_id() to authenticated, service_role;
grant execute on function private.user_in_thread(uuid) to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_metrics enable row level security;
alter table public.orders enable row level security;
alter table public.batches enable row level security;
alter table public.messages enable row level security;
alter table public.disruptions enable row level security;
alter table public.strategies enable row level security;
alter table public.legal_docs enable row level security;
alter table public.decisions enable row level security;

alter table public.profiles force row level security;
alter table public.suppliers force row level security;
alter table public.supplier_metrics force row level security;
alter table public.orders force row level security;
alter table public.batches force row level security;
alter table public.messages force row level security;
alter table public.disruptions force row level security;
alter table public.strategies force row level security;
alter table public.legal_docs force row level security;
alter table public.decisions force row level security;

-- profiles
create policy profiles_select_own_or_owner
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_business_owner())
  );

create policy profiles_insert_own_supplier
  on public.profiles for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = 'supplier'
  );

create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and role = (select private.current_app_role())
  );

create policy profiles_update_owner
  on public.profiles for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

-- suppliers
create policy suppliers_select
  on public.suppliers for select to authenticated
  using (
    (select private.is_business_owner())
    or id = (select private.current_supplier_id())
  );

create policy suppliers_insert_owner
  on public.suppliers for insert to authenticated
  with check ((select private.is_business_owner()));

create policy suppliers_update_owner
  on public.suppliers for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy suppliers_delete_owner
  on public.suppliers for delete to authenticated
  using ((select private.is_business_owner()));

-- supplier_metrics
create policy supplier_metrics_select
  on public.supplier_metrics for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy supplier_metrics_insert_owner
  on public.supplier_metrics for insert to authenticated
  with check ((select private.is_business_owner()));

create policy supplier_metrics_update_owner
  on public.supplier_metrics for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy supplier_metrics_delete_owner
  on public.supplier_metrics for delete to authenticated
  using ((select private.is_business_owner()));

-- orders
create policy orders_select
  on public.orders for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy orders_insert_owner
  on public.orders for insert to authenticated
  with check ((select private.is_business_owner()));

create policy orders_update_owner
  on public.orders for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy orders_delete_owner
  on public.orders for delete to authenticated
  using ((select private.is_business_owner()));

-- batches
create policy batches_select
  on public.batches for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy batches_insert
  on public.batches for insert to authenticated
  with check (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy batches_update
  on public.batches for update to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  )
  with check (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

-- messages: owners see all; suppliers see threads they participate in
create policy messages_select
  on public.messages for select to authenticated
  using (
    (select private.is_business_owner())
    or sender_id = (select auth.uid())
    or (select private.user_in_thread(thread_id))
  );

create policy messages_insert
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and sender_role = (select private.current_app_role())
  );

create policy messages_update_own_or_owner
  on public.messages for update to authenticated
  using (
    (select private.is_business_owner())
    or sender_id = (select auth.uid())
  )
  with check (
    (select private.is_business_owner())
    or sender_id = (select auth.uid())
  );

-- disruptions
create policy disruptions_select
  on public.disruptions for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy disruptions_insert_owner
  on public.disruptions for insert to authenticated
  with check ((select private.is_business_owner()));

create policy disruptions_update_owner
  on public.disruptions for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy disruptions_delete_owner
  on public.disruptions for delete to authenticated
  using ((select private.is_business_owner()));

-- strategies (owner dashboard)
create policy strategies_select_owner
  on public.strategies for select to authenticated
  using ((select private.is_business_owner()));

create policy strategies_insert_owner
  on public.strategies for insert to authenticated
  with check ((select private.is_business_owner()));

create policy strategies_update_owner
  on public.strategies for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy strategies_delete_owner
  on public.strategies for delete to authenticated
  using ((select private.is_business_owner()));

-- legal_docs
create policy legal_docs_select
  on public.legal_docs for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy legal_docs_insert
  on public.legal_docs for insert to authenticated
  with check (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy legal_docs_update
  on public.legal_docs for update to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  )
  with check (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

-- decisions (owner dashboard; agents write via service_role)
create policy decisions_select_owner
  on public.decisions for select to authenticated
  using ((select private.is_business_owner()));

create policy decisions_insert_owner
  on public.decisions for insert to authenticated
  with check ((select private.is_business_owner()));

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.suppliers,
  public.supplier_metrics,
  public.orders,
  public.batches,
  public.messages,
  public.disruptions,
  public.strategies,
  public.legal_docs,
  public.decisions
to authenticated;

grant usage, select on all sequences in schema public to authenticated;

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.disruptions;
alter publication supabase_realtime add table public.strategies;
alter publication supabase_realtime add table public.decisions;
alter publication supabase_realtime add table public.orders;
