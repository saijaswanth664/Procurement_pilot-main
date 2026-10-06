-- Cloudinary public_ids + inspect timestamp. Photos/PDFs stay off-Postgres.
alter table public.batches
  add column if not exists photo_public_id text,
  add column if not exists reported_pdf_public_id text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists batches_created_at_idx on public.batches (created_at desc);

-- Suppliers may open a QC intake order for their own supplier_id only.
create policy orders_insert_supplier
  on public.orders for insert to authenticated
  with check (
    supplier_id = (select private.current_supplier_id())
    and (select private.current_app_role()) = 'supplier'
    and business_id = (select auth.uid())
  );

alter publication supabase_realtime add table public.batches;

insert into public.orders (business_id, supplier_id, sku, qty_ordered, qty_allocated, status)
select p.id, s.id, v.sku, v.qty, v.qty, 'in_transit'
from public.profiles p
cross join (
  values
    (1, 'ASHWAGANDHA-ROOT-POWDER', 350::numeric),
    (6, 'AMBER-DROPPER-30ML', 18000::numeric)
) as v(supplier_id, sku, qty)
join public.suppliers s on s.id = v.supplier_id
where p.role = 'business_owner'
  and not exists (
    select 1 from public.orders o
    where o.sku = v.sku and o.supplier_id = v.supplier_id
  );
