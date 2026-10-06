-- Forecast snapshots are append-only so a disruption can insert a shocked row.
alter table public.supplier_forecasts
  drop constraint if exists supplier_forecasts_supplier_id_forecast_date_horizon_days_key;

alter table public.disruptions
  add column if not exists run_id uuid;

create index if not exists disruptions_run_id_idx on public.disruptions (run_id);

alter table public.supplier_forecasts
  add column if not exists disruption_id bigint references public.disruptions (id) on delete set null;

create index if not exists supplier_forecasts_disruption_id_idx
  on public.supplier_forecasts (disruption_id);

create index if not exists supplier_forecasts_latest_idx
  on public.supplier_forecasts (supplier_id, generated_at desc);

comment on column public.disruptions.run_id is
  'Strategies written by the re-plan loop share this uuid.';
comment on column public.supplier_forecasts.disruption_id is
  'Null for the original ridge snapshot; set when this row is a shocked copy.';
