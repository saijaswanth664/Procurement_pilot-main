-- 14-day supplier performance forecasts for the optimizer.
-- predicted_reliability is delivery reliability in [0,1], not 1 - defect_rate:
--   1 / (1 + max(0, lead_time - 28d_median_lead) / nullif(28d_median_lead, 0)).

create table public.supplier_forecasts (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers (id) on delete cascade,
  forecast_date date not null,
  horizon_days integer not null check (horizon_days > 0),
  predicted_price numeric not null check (predicted_price >= 0),
  predicted_reliability numeric not null check (
    predicted_reliability >= 0 and predicted_reliability <= 1
  ),
  predicted_lead_time numeric not null check (predicted_lead_time >= 0),
  predicted_defect_rate numeric not null check (predicted_defect_rate >= 0),
  predicted_capacity_util numeric not null check (predicted_capacity_util >= 0),
  model_type text not null,
  uncertainty jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  unique (supplier_id, forecast_date, horizon_days)
);

comment on table public.supplier_forecasts is
  'One row per supplier snapshot: 14-day-ahead ridge forecasts plus holdout MAE/residual std in uncertainty.';
comment on column public.supplier_forecasts.predicted_reliability is
  'Delivery reliability [0,1]: 1/(1+lateness vs 28-day median lead). Distinct from predicted_defect_rate (quality-risk).';
comment on column public.supplier_forecasts.predicted_capacity_util is
  'Implied monthly utilization: daily capacity_used * 30 / suppliers.max_capacity.';
comment on column public.supplier_forecasts.forecast_date is
  'As-of date (last observed metric day). Predictions are for forecast_date + horizon_days.';

create index supplier_forecasts_supplier_id_idx
  on public.supplier_forecasts (supplier_id);
create index supplier_forecasts_forecast_date_idx
  on public.supplier_forecasts (forecast_date desc);

alter table public.supplier_forecasts enable row level security;
alter table public.supplier_forecasts force row level security;

create policy supplier_forecasts_select
  on public.supplier_forecasts for select to authenticated
  using (
    (select private.is_business_owner())
    or supplier_id = (select private.current_supplier_id())
  );

create policy supplier_forecasts_insert_owner
  on public.supplier_forecasts for insert to authenticated
  with check ((select private.is_business_owner()));

create policy supplier_forecasts_update_owner
  on public.supplier_forecasts for update to authenticated
  using ((select private.is_business_owner()))
  with check ((select private.is_business_owner()));

create policy supplier_forecasts_delete_owner
  on public.supplier_forecasts for delete to authenticated
  using ((select private.is_business_owner()));

grant select, insert, update, delete on public.supplier_forecasts to authenticated;
