#!/usr/bin/env python3
"""Disruption → mutate latest forecast → re-run PuLP → log decisions.

  python scripts/trigger_disruption.py --demo ayurform-capacity \\
      --json scripts/.cache/supplier_forecasts.json --write-sql scripts/.cache/disruption.sql

magnitude is a percent: price multiplies by (1 + m/100); capacity eats m% of
remaining headroom toward util=0.999; reliability lifts defect/lead and their std.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from optimize_allocation import (
    DEFAULT_DEMAND,
    SWEEP,
    Allocation,
    SupplierOpt,
    allocation_json,
    load_csv,
    load_json,
    optimize_category,
    parse_demand,
    refresh_open,
)

DEMAND = dict(DEFAULT_DEMAND)


def _bump_std(unc: dict[str, Any], key: str, factor: float) -> None:
    block = dict(unc.get(key) or {})
    std = float(block.get("std") or 0.0) * factor
    block["std"] = std
    unc[key] = block


def apply_shock(src: SupplierOpt, dtype: str, magnitude_pct: float) -> SupplierOpt:
    """Return a new supplier snapshot; never mutates src."""
    m = magnitude_pct / 100.0
    if m < 0:
        raise ValueError("magnitude is a percentage change; use a non-negative number")
    s = replace(src, uncertainty=copy.deepcopy(src.uncertainty or {}))
    unc = s.uncertainty
    if dtype == "price":
        s.predicted_price = s.predicted_price * (1.0 + m)
        s.lead_std = s.lead_std  # unchanged
        _bump_std(unc, "price", 1.0 + 0.5 * m)
    elif dtype == "capacity":
        slack = max(0.0, 0.999 - s.predicted_capacity_util)
        s.predicted_capacity_util = min(0.999, s.predicted_capacity_util + slack * m)
        s.util_std = s.util_std * (1.0 + 0.5 * m)
        _bump_std(unc, "capacity_util", 1.0 + 0.5 * m)
        refresh_open(s)
    elif dtype == "reliability":
        s.predicted_defect_rate = min(0.25, s.predicted_defect_rate * (1.0 + m))
        s.predicted_lead_time = min(45.0, s.predicted_lead_time * (1.0 + 0.5 * m))
        s.predicted_reliability = max(0.05, s.predicted_reliability * (1.0 - m))
        s.defect_std = s.defect_std * (1.0 + m)
        s.lead_std = s.lead_std * (1.0 + m)
        _bump_std(unc, "defect_rate", 1.0 + m)
        _bump_std(unc, "lead_time", 1.0 + m)
        _bump_std(unc, "reliability", 1.0 + m)
    else:
        raise ValueError(f"type must be price|capacity|reliability, got {dtype}")
    refresh_open(s)
    return s


def make_bookable(s: SupplierOpt, demand: float) -> SupplierOpt:
    """If forecast leftover < MOQ, open a sliver of headroom so a capacity-cut can *move* qty."""
    need = min(s.max_capacity * 0.20, max(s.moq, demand))
    if s.available + 1e-9 >= need:
        return s
    out = replace(s, uncertainty=copy.deepcopy(s.uncertainty or {}))
    out.predicted_capacity_util = max(0.50, 1.0 - need / out.max_capacity)
    refresh_open(out)
    return out


def _qty_label(alloc: Allocation, suppliers: list[SupplierOpt]) -> dict[str, float]:
    return alloc.qty_named(suppliers)


def pick_label(solved: list[Allocation], label: str) -> Allocation:
    for a in solved:
        if a.label == label:
            return a
    return solved[0]


@dataclass
class TriggerResult:
    run_id: str
    disruption: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any]
    decision_text: str
    reasoning: str
    suppliers: list[SupplierOpt]
    shocked: SupplierOpt
    solved_before: list[Allocation]
    solved_after: list[Allocation]
    baselines_after: tuple[Allocation, Allocation]
    category: str
    before_group: list[SupplierOpt]
    after_group: list[SupplierOpt]
    before_supplier: SupplierOpt


def trigger_disruption(
    suppliers: list[SupplierOpt],
    supplier_id: int,
    dtype: str,
    magnitude_pct: float,
    *,
    demand_map: dict[str, float] | None = None,
    prepare_bookable: bool = False,
    compare_label: str = "balanced",
) -> TriggerResult:
    """Shock one supplier, re-solve every category they are in (usually one)."""
    demand_map = dict(DEMAND if demand_map is None else demand_map)
    run_id = str(uuid.uuid4())
    pool = [replace(s, uncertainty=copy.deepcopy(s.uncertainty or {})) for s in suppliers]
    target = next((s for s in pool if s.id == supplier_id), None)
    if target is None:
        raise ValueError(f"unknown supplier_id {supplier_id}")
    category = target.category
    demand = demand_map[category]

    if prepare_bookable:
        opened = make_bookable(target, demand)
        pool = [opened if s.id == supplier_id else s for s in pool]
        target = opened

    before_group = [s for s in pool if s.category == category]
    solved_b, single_b, even_b = optimize_category(before_group, demand)
    before_alloc = pick_label(solved_b, compare_label)

    shocked = apply_shock(target, dtype, magnitude_pct)
    after_pool = [shocked if s.id == supplier_id else s for s in pool]
    after_group = [s for s in after_pool if s.category == category]
    solved_a, single_a, even_a = optimize_category(after_group, demand)
    after_alloc = pick_label(solved_a, compare_label)

    before_qty = _qty_label(before_alloc, before_group)
    after_qty = _qty_label(after_alloc, after_group)
    decision_text = (
        f"{dtype} disruption {magnitude_pct:g}% on {target.name} "
        f"(supplier_id={supplier_id}); re-planned {category} ({compare_label})."
    )
    reasoning = (
        f"Shock type={dtype}, magnitude={magnitude_pct:g}% (percent). "
        f"Forecast util {target.predicted_capacity_util:.4f} → {shocked.predicted_capacity_util:.4f}, "
        f"price {target.predicted_price:.4f} → {shocked.predicted_price:.4f}, "
        f"defect {target.predicted_defect_rate:.5f} → {shocked.predicted_defect_rate:.5f}, "
        f"lead {target.predicted_lead_time:.3f} → {shocked.predicted_lead_time:.3f}, "
        f"available {target.available:.1f} → {shocked.available:.1f} "
        f"(open {target.open} → {shocked.open}). "
        f"Before {compare_label}: cost={before_alloc.expected_cost:.2f} "
        f"risk={before_alloc.expected_risk:.4f} qty={before_qty}. "
        f"After {compare_label}: cost={after_alloc.expected_cost:.2f} "
        f"risk={after_alloc.expected_risk:.4f} qty={after_qty}. "
        f"Delta cost={after_alloc.expected_cost - before_alloc.expected_cost:.2f} "
        f"({((after_alloc.expected_cost - before_alloc.expected_cost) / before_alloc.expected_cost * 100) if before_alloc.expected_cost else 0:.1f}%), "
        f"delta risk={after_alloc.expected_risk - before_alloc.expected_risk:.4f}."
    )

    return TriggerResult(
        run_id=run_id,
        disruption={
            "supplier_id": supplier_id,
            "type": dtype,
            "magnitude": magnitude_pct,
            "run_id": run_id,
        },
        before={
            "label": before_alloc.label,
            "qty": before_qty,
            "expected_cost": before_alloc.expected_cost,
            "expected_risk": before_alloc.expected_risk,
            "status": before_alloc.status,
            "util": target.predicted_capacity_util,
            "available": target.available,
            "open": target.open,
        },
        after={
            "label": after_alloc.label,
            "qty": after_qty,
            "expected_cost": after_alloc.expected_cost,
            "expected_risk": after_alloc.expected_risk,
            "status": after_alloc.status,
            "util": shocked.predicted_capacity_util,
            "available": shocked.available,
            "open": shocked.open,
        },
        decision_text=decision_text,
        reasoning=reasoning,
        suppliers=after_pool,
        shocked=shocked,
        solved_before=solved_b,
        solved_after=solved_a,
        baselines_after=(single_a, even_a),
        category=category,
        before_group=before_group,
        after_group=after_group,
        before_supplier=target,
    )


def print_diff(result: TriggerResult) -> None:
    print(f"run_id={result.run_id}")
    print(f"disruption: supplier_id={result.disruption['supplier_id']} "
          f"type={result.disruption['type']} magnitude={result.disruption['magnitude']}%")
    print()
    print(f"{'':18} {'BEFORE':>42} {'AFTER':>42}")
    print(f"{'open':18} {str(result.before['open']):>42} {str(result.after['open']):>42}")
    print(f"{'util':18} {result.before['util']:42.4f} {result.after['util']:42.4f}")
    print(f"{'available':18} {result.before['available']:42.1f} {result.after['available']:42.1f}")
    print()
    print(f"{'λ strategy':<20} {'before qty':<40} {'after qty':<40} {'cost Δ':>10} {'risk Δ':>10}")
    by_b = {a.label: a for a in result.solved_before}
    by_a = {a.label: a for a in result.solved_after}
    for label, _w in SWEEP:
        b = by_b[label]
        a = by_a[label]
        bq = json.dumps(_qty_label(b, result.before_group))
        aq = json.dumps(_qty_label(a, result.after_group))
        print(
            f"{label:<20} {bq:<40} {aq:<40} "
            f"{a.expected_cost - b.expected_cost:10.2f} {a.expected_risk - b.expected_risk:10.4f}"
        )
        print(
            f"{'':20} cost {b.expected_cost:.2f} → {a.expected_cost:.2f}   "
            f"risk {b.expected_risk:.4f} → {a.expected_risk:.4f}"
        )
    print()
    print("decision:", result.decision_text)
    print("reasoning:", result.reasoning)


def _esc(obj: Any) -> str:
    return json.dumps(obj).replace("'", "''")


def result_sql(result: TriggerResult, *, forecast_date: str = "2026-08-28") -> str:
    shocked = result.shocked
    before_s = result.before_supplier
    unc_b = _esc(before_s.uncertainty or {})
    unc = _esc(shocked.uncertainty or {})
    model = f"ridge_direct_14d+{result.disruption['type']}_shock"
    payload_rows = []
    group = [s for s in result.suppliers if s.category == result.category]
    single, even = result.baselines_after
    for a in result.solved_after:
        if a.status != "Optimal":
            continue
        payload = allocation_json(a, group, result.run_id, single, even)
        payload["disruption"] = result.disruption
        payload["before"] = result.before
        payload["after"] = result.after
        payload_rows.append(
            f"  ('{result.run_id}'::uuid, {a.risk_weight}, '{_esc(payload)}'::jsonb, "
            f"{a.expected_cost:.6f}, {a.expected_risk:.6f})"
        )
    strategies = ""
    if payload_rows:
        strategies = (
            "insert into public.strategies (run_id, risk_weight, allocation_json, expected_cost, expected_risk)\nvalues\n"
            + ",\n".join(payload_rows)
            + ";\n"
        )
    reasoning = result.reasoning.replace("'", "''")
    text = result.decision_text.replace("'", "''")
    return f"""-- disruption re-plan run_id {result.run_id}
insert into public.supplier_forecasts (
  supplier_id, forecast_date, horizon_days,
  predicted_price, predicted_reliability, predicted_lead_time,
  predicted_defect_rate, predicted_capacity_util,
  model_type, uncertainty, generated_at
) values (
  {before_s.id},
  '{forecast_date}'::date,
  14,
  {before_s.predicted_price:.6f},
  {before_s.predicted_reliability:.6f},
  {before_s.predicted_lead_time:.6f},
  {before_s.predicted_defect_rate:.6f},
  {before_s.predicted_capacity_util:.6f},
  'ridge_direct_14d+bookable_presnapshot',
  '{unc_b}'::jsonb,
  now() - interval '1 second'
);

insert into public.disruptions (supplier_id, type, magnitude, run_id)
values (
  {shocked.id},
  '{result.disruption["type"]}'::public.disruption_type,
  {result.disruption["magnitude"]},
  '{result.run_id}'::uuid
);

insert into public.supplier_forecasts (
  supplier_id, forecast_date, horizon_days,
  predicted_price, predicted_reliability, predicted_lead_time,
  predicted_defect_rate, predicted_capacity_util,
  model_type, uncertainty, disruption_id
)
select
  {shocked.id},
  '{forecast_date}'::date,
  14,
  {shocked.predicted_price:.6f},
  {shocked.predicted_reliability:.6f},
  {shocked.predicted_lead_time:.6f},
  {shocked.predicted_defect_rate:.6f},
  {shocked.predicted_capacity_util:.6f},
  '{model}',
  '{unc}'::jsonb,
  d.id
from public.disruptions d
where d.run_id = '{result.run_id}'::uuid
order by d.id desc
limit 1;

{strategies}
insert into public.decisions (
  related_entity_type, related_entity_id, decision_text, reasoning, made_by
)
select
  'disruption',
  d.id,
  '{text}',
  '{reasoning}',
  'agent'::public.decision_maker
from public.disruptions d
where d.run_id = '{result.run_id}'::uuid
order by d.id desc
limit 1;
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--supplier-id", type=int)
    parser.add_argument("--type", choices=("price", "capacity", "reliability"))
    parser.add_argument("--magnitude", type=float, help="Percent change, e.g. 80 = 80%.")
    parser.add_argument("--demo", choices=("ayurform-capacity",))
    parser.add_argument("--prepare-bookable", action="store_true")
    parser.add_argument("--demand", action="append")
    parser.add_argument("--write-sql", type=Path)
    args = parser.parse_args()
    if bool(args.json) == bool(args.csv):
        print("pass exactly one of --json or --csv", file=sys.stderr)
        return 1
    suppliers = load_json(args.json) if args.json else load_csv(args.csv)
    demand_map = parse_demand(args.demand)

    if args.demo == "ayurform-capacity":
        target = next(s for s in suppliers if s.name == "AyurForm CMO Hyderabad")
        result = trigger_disruption(
            suppliers,
            target.id,
            "capacity",
            80.0,
            demand_map=demand_map,
            prepare_bookable=True,
            compare_label="cost_aggressive",
        )
    else:
        if args.supplier_id is None or args.type is None or args.magnitude is None:
            print("need --supplier-id --type --magnitude, or --demo ayurform-capacity", file=sys.stderr)
            return 1
        result = trigger_disruption(
            suppliers,
            args.supplier_id,
            args.type,
            args.magnitude,
            demand_map=demand_map,
            prepare_bookable=args.prepare_bookable,
        )

    print_diff(result)
    nilgiri = "Nilgiri Herb Processors"
    after_qty = result.after["qty"]
    if args.demo == "ayurform-capacity":
        if set(after_qty.keys()) == {nilgiri} and abs(sum(after_qty.values()) - demand_map["contract_manufacturing"]) < 1e-6:
            print("CHECK: CMO allocation after shock is 100% Nilgiri.")
        else:
            print(f"CHECK FAILED: expected 100% Nilgiri, got {after_qty}", file=sys.stderr)
            return 1
        if "AyurForm CMO Hyderabad" in result.before["qty"]:
            print("CHECK: before shock AyurForm held qty (shift is visible).")
        else:
            print("NOTE: before allocation did not include AyurForm; shift may be a no-op.")
    if args.write_sql:
        args.write_sql.write_text(result_sql(result))
        print(f"wrote {args.write_sql}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
