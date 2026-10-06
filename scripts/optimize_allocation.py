#!/usr/bin/env python3
"""PuLP allocation: split a category order across suppliers.

Reads latest-style forecast rows (CSV/JSON). Decision var = qty per supplier.
  • qty_i = 0  or  moq_i ≤ qty_i ≤ available_i
  • available_i = max_capacity_i * (1 - predicted_capacity_util_i)  (forecast ceiling)
  • demand is an input, not a hardcoded order

Objective:
  min Σ (predicted_price_i + risk_weight * median_price * unit_risk_i) * qty_i

unit_risk_i (O(1) typical; Deccan ≫ 1):
  0.40 * (lead_std / 0.5d)
  0.40 * ((predicted_defect + defect_std) / 0.02)
  0.20 * ((util/(1-util)) / 2)

  python scripts/optimize_allocation.py --json scripts/.cache/supplier_forecasts.json
  python scripts/optimize_allocation.py --json ... --demand raw_herbs=350 --write-sql /tmp/s.sql
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pulp

CATEGORIES = ("raw_herbs", "packaging", "contract_manufacturing")

# rupees of median-price per unit of composite risk. 0 = cheapest fill.
# Anchors make unit_risk ~O(1) for a typical supplier; Deccan lands well above 1.
LATE_ANCHOR = 0.5  # days of lead-time std
QUAL_ANCHOR = 0.02  # defect mean+1σ
CAP_ANCHOR = 2.0  # util/(1-util); util=0.67 → 2

SWEEP = (
    ("cost_aggressive", 0.0),
    ("balanced", 0.7),
    ("risk_averse", 4.0),
)

W_LATE, W_QUAL, W_CAP = 0.40, 0.40, 0.20

# Small-to-mid D2C cycle sizes; override with --demand. Must fit remaining headroom.
DEFAULT_DEMAND = {
    "raw_herbs": 350.0,  # kg — Khejri can solo; risk sweep should diversify
    "packaging": 18000.0,  # units — even split ≥ LabelCraft MOQ
    "contract_manufacturing": 8000.0,  # units — AyurForm likely closed at ceiling
}


@dataclass
class SupplierOpt:
    id: int
    name: str
    category: str
    moq: float
    max_capacity: float
    predicted_price: float
    predicted_lead_time: float
    predicted_defect_rate: float
    predicted_capacity_util: float
    predicted_reliability: float
    lead_std: float
    defect_std: float
    util_std: float
    uncertainty: dict[str, Any] = field(default_factory=dict)
    available: float = 0.0
    unit_risk: float = 0.0
    late_n: float = 0.0
    qual_n: float = 0.0
    cap_n: float = 0.0
    open: bool = True


@dataclass
class Allocation:
    label: str
    risk_weight: float
    demand: float
    category: str
    qty: dict[int, float]
    expected_cost: float
    expected_risk: float
    status: str
    notes: str = ""
    solver: str = "PULP_CBC_CMD"

    def qty_named(self, suppliers: list[SupplierOpt]) -> dict[str, float]:
        names = {s.id: s.name for s in suppliers}
        return {names[i]: q for i, q in self.qty.items() if q > 1e-6}


def _f(x: Any, default: float = 0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def forecast_available(max_capacity: float, util: float) -> float:
    """Bookable qty this cycle: unused monthly capacity from the util forecast."""
    util = min(max(util, 0.0), 0.999)
    return max(0.0, max_capacity * (1.0 - util))


def refresh_open(s: SupplierOpt) -> None:
    s.available = forecast_available(s.max_capacity, s.predicted_capacity_util)
    s.open = s.available + 1e-9 >= s.moq


def attach_risk(suppliers: list[SupplierOpt]) -> None:
    """Absolute scores (not min-max). Deccan stays high even when it is the cheapest kg."""
    for s in suppliers:
        s.late_n = s.lead_std / LATE_ANCHOR
        s.qual_n = (s.predicted_defect_rate + s.defect_std) / QUAL_ANCHOR
        cap_stress = s.predicted_capacity_util / max(1e-3, 1.0 - min(s.predicted_capacity_util, 0.999))
        s.cap_n = cap_stress / CAP_ANCHOR
        s.unit_risk = W_LATE * s.late_n + W_QUAL * s.qual_n + W_CAP * s.cap_n


def parse_rows(rows: list[dict[str, Any]]) -> list[SupplierOpt]:
    out: list[SupplierOpt] = []
    for raw in rows:
        unc = raw.get("uncertainty") or {}
        if isinstance(unc, str):
            unc = json.loads(unc)
        def std(key: str) -> float:
            block = unc.get(key) or {}
            return _f(block.get("std"))

        cap = _f(raw.get("max_capacity"))
        util = _f(raw.get("predicted_capacity_util"))
        moq = _f(raw.get("moq"))
        available = forecast_available(cap, util)
        s = SupplierOpt(
            id=int(raw["id"] if "id" in raw else raw["supplier_id"]),
            name=str(raw["name"]),
            category=str(raw["category"]),
            moq=moq,
            max_capacity=cap,
            predicted_price=_f(raw["predicted_price"]),
            predicted_lead_time=_f(raw.get("predicted_lead_time")),
            predicted_defect_rate=_f(raw["predicted_defect_rate"]),
            predicted_capacity_util=util,
            predicted_reliability=_f(raw.get("predicted_reliability"), 1.0),
            lead_std=std("lead_time"),
            defect_std=std("defect_rate"),
            util_std=std("capacity_util"),
            uncertainty=unc if isinstance(unc, dict) else {},
            available=available,
            open=available + 1e-9 >= moq,
        )
        out.append(s)
    return out


def load_json(path: Path) -> list[SupplierOpt]:
    payload = json.loads(path.read_text())
    rows = payload if isinstance(payload, list) else payload["suppliers"]
    return parse_rows(rows)


def load_csv(path: Path) -> list[SupplierOpt]:
    with path.open(newline="") as f:
        return parse_rows(list(csv.DictReader(f)))


def cost_risk(suppliers: list[SupplierOpt], qty: dict[int, float]) -> tuple[float, float]:
    by_id = {s.id: s for s in suppliers}
    total_q = sum(qty.values())
    cost = sum(by_id[i].predicted_price * q for i, q in qty.items())
    if total_q <= 1e-9:
        return cost, 0.0
    risk = sum(by_id[i].unit_risk * q for i, q in qty.items()) / total_q
    return cost, risk


def solve_pulp(
    suppliers: list[SupplierOpt],
    demand: float,
    risk_weight: float,
    label: str,
) -> Allocation:
    open_s = [s for s in suppliers if s.open]
    if not open_s:
        return Allocation(label, risk_weight, demand, suppliers[0].category, {}, 0.0, 0.0, "Infeasible", "no supplier with available ≥ moq")
    total_avail = sum(s.available for s in open_s)
    cat = suppliers[0].category
    if demand > total_avail + 1e-6:
        return Allocation(
            label, risk_weight, demand, cat, {}, 0.0, 0.0, "Infeasible",
            f"demand {demand:.1f} > total available {total_avail:.1f}",
        )

    prices = sorted(s.predicted_price for s in open_s)
    mid = len(prices) // 2
    median_price = prices[mid] if len(prices) % 2 else 0.5 * (prices[mid - 1] + prices[mid])
    prob = pulp.LpProblem(f"alloc_{cat}_{label}", pulp.LpMinimize)
    qty = {
        s.id: pulp.LpVariable(f"qty_{s.id}", lowBound=0, upBound=s.available, cat="Continuous")
        for s in open_s
    }
    use = {s.id: pulp.LpVariable(f"use_{s.id}", cat="Binary") for s in open_s}
    for s in open_s:
        # qty = 0  XOR  moq ≤ qty ≤ available
        prob += qty[s.id] <= s.available * use[s.id]
        prob += qty[s.id] >= s.moq * use[s.id]
    prob += pulp.lpSum(qty[s.id] for s in open_s) == demand
    prob += pulp.lpSum(
        (s.predicted_price + risk_weight * median_price * s.unit_risk) * qty[s.id]
        for s in open_s
    )

    status_code = prob.solve(pulp.PULP_CBC_CMD(msg=False))
    status = pulp.LpStatus[status_code]
    if status != "Optimal":
        return Allocation(label, risk_weight, demand, cat, {}, 0.0, 0.0, status, "CBC did not prove optimal")

    qmap = {s.id: float(qty[s.id].value() or 0.0) for s in open_s}
    qmap = {i: q for i, q in qmap.items() if q > 1e-6}
    cost, risk = cost_risk(suppliers, qmap)
    return Allocation(
        label=label,
        risk_weight=risk_weight,
        demand=demand,
        category=cat,
        qty=qmap,
        expected_cost=cost,
        expected_risk=risk,
        status="Optimal",
        notes=(
            f"min Σ (price + {risk_weight} * median_price({median_price:.2f}) * unit_risk) * qty; "
            f"unit_risk = {W_LATE}*(lead_std/{LATE_ANCHOR}) + {W_QUAL}*((defect+σ)/{QUAL_ANCHOR}) + {W_CAP}*(util/(1-util)/{CAP_ANCHOR}); "
            f"qty=0 or moq≤qty≤available; Σqty={demand:g}; available=max_capacity*(1-predicted_capacity_util)"
        ),
    )


def baseline_single_cheapest(suppliers: list[SupplierOpt], demand: float) -> Allocation:
    """100% to the cheapest supplier who can fill the order; else cheapest open (partial)."""
    cat = suppliers[0].category
    open_s = [s for s in suppliers if s.open]
    fillers = [s for s in open_s if s.available + 1e-9 >= demand and demand + 1e-9 >= s.moq]
    if fillers:
        pick = min(fillers, key=lambda s: s.predicted_price)
        qmap = {pick.id: demand}
        note = f"single supplier {pick.name} (cheapest who can fill {demand:g})"
        status = "Baseline"
    elif open_s:
        pick = min(open_s, key=lambda s: s.predicted_price)
        q = min(demand, pick.available)
        qmap = {pick.id: q} if q + 1e-9 >= pick.moq else {}
        note = f"single supplier {pick.name} cannot fill {demand:g}; allocated {q:.1f}"
        status = "Baseline-shortfall"
    else:
        return Allocation("single_cheapest", 0.0, demand, cat, {}, 0.0, 0.0, "Infeasible", "no open suppliers")
    cost, risk = cost_risk(suppliers, qmap)
    return Allocation("single_cheapest", 0.0, demand, cat, qmap, cost, risk, status, note)


def baseline_even_split(suppliers: list[SupplierOpt], demand: float) -> Allocation:
    """Equal split across open suppliers, clipped to [moq, available], then repaired to demand."""
    cat = suppliers[0].category
    open_s = [s for s in suppliers if s.open]
    if not open_s:
        return Allocation("even_split", 0.0, demand, cat, {}, 0.0, 0.0, "Infeasible", "no open suppliers")
    n = len(open_s)
    raw = {s.id: demand / n for s in open_s}
    qmap: dict[int, float] = {}
    for s in open_s:
        q = raw[s.id]
        if q < s.moq:
            q = s.moq if s.moq <= s.available else 0.0
        q = min(q, s.available)
        if q > 1e-9:
            qmap[s.id] = q
    total = sum(qmap.values())
    # Scale down if naive MOQ-lift overshot demand.
    if total > demand + 1e-6:
        extra = total - demand
        # peel from largest allocations first, not below moq
        by_id = {s.id: s for s in open_s}
        for sid in sorted(qmap, key=lambda i: qmap[i], reverse=True):
            s = by_id[sid]
            peelable = qmap[sid] - s.moq
            take = min(extra, max(0.0, peelable))
            qmap[sid] -= take
            extra -= take
            if extra <= 1e-9:
                break
        qmap = {i: q for i, q in qmap.items() if q > 1e-6}
        total = sum(qmap.values())
    # Scale up leftover into remaining headroom (ignore extra MOQ).
    if total + 1e-6 < demand:
        leftover = demand - total
        by_id = {s.id: s for s in open_s}
        room = [(s.id, s.available - qmap.get(s.id, 0.0)) for s in open_s]
        room = [(i, r) for i, r in room if r > 1e-9]
        for sid, r in room:
            if leftover <= 1e-9:
                break
            add = min(r, leftover)
            qmap[sid] = qmap.get(sid, 0.0) + add
            leftover -= add
    cost, risk = cost_risk(suppliers, qmap)
    return Allocation("even_split", 0.0, demand, cat, qmap, cost, risk, "Baseline", "equal split across open suppliers")


def pct_impr(new: float, base: float) -> float | None:
    if base <= 1e-12:
        return None
    return (base - new) / base * 100.0


def fmt_pct(v: float | None) -> str:
    if v is None:
        return "  n/a"
    return f"{v:6.1f}%"


def _baseline_blob(a: Allocation, suppliers: list[SupplierOpt]) -> dict[str, Any]:
    return {
        "label": a.label,
        "expected_cost": a.expected_cost,
        "expected_risk": a.expected_risk,
        "status": a.status,
        "notes": a.notes,
        "qty": a.qty_named(suppliers),
    }


def allocation_json(
    alloc: Allocation,
    suppliers: list[SupplierOpt],
    run_id: str,
    single: Allocation | None = None,
    even: Allocation | None = None,
) -> dict[str, Any]:
    by_id = {s.id: s for s in suppliers}
    payload: dict[str, Any] = {
        "run_id": run_id,
        "label": alloc.label,
        "category": alloc.category,
        "demand": alloc.demand,
        "risk_weight": alloc.risk_weight,
        "solver": alloc.solver,
        "status": alloc.status,
        "objective": alloc.notes,
        "expected_cost": alloc.expected_cost,
        "expected_risk": alloc.expected_risk,
        "closed_suppliers": [
            {
                "id": s.id,
                "name": s.name,
                "reason": "available < moq (forecast capacity ceiling)",
                "available": s.available,
                "moq": s.moq,
            }
            for s in suppliers
            if not s.open
        ],
        "suppliers": [
            {
                "id": sid,
                "name": by_id[sid].name,
                "qty": q,
                "predicted_price": by_id[sid].predicted_price,
                "unit_risk": by_id[sid].unit_risk,
                "moq": by_id[sid].moq,
                "available": by_id[sid].available,
                "predicted_defect_rate": by_id[sid].predicted_defect_rate,
                "predicted_lead_time": by_id[sid].predicted_lead_time,
                "predicted_capacity_util": by_id[sid].predicted_capacity_util,
            }
            for sid, q in sorted(alloc.qty.items())
        ],
    }
    if single is not None and even is not None:
        payload["baselines"] = {
            "single_cheapest": _baseline_blob(single, suppliers),
            "even_split": _baseline_blob(even, suppliers),
        }
        payload["improvement_pct"] = {
            "cost_vs_single": pct_impr(alloc.expected_cost, single.expected_cost),
            "risk_vs_single": pct_impr(alloc.expected_risk, single.expected_risk),
            "cost_vs_even": pct_impr(alloc.expected_cost, even.expected_cost),
            "risk_vs_even": pct_impr(alloc.expected_risk, even.expected_risk),
        }
    return payload


def print_category_report(
    cat: str,
    demand: float,
    suppliers: list[SupplierOpt],
    solved: list[Allocation],
    single: Allocation,
    even: Allocation,
) -> None:
    print()
    print(f"=== {cat}  demand={demand:g} ===")
    print(f"{'supplier':<28} {'open':>4} {'moq':>8} {'avail':>8} {'price':>10} {'u_risk':>7} {'def%':>7} {'util':>6}")
    for s in suppliers:
        print(
            f"{s.name:<28} {'Y' if s.open else 'N':>4} {s.moq:8.0f} {s.available:8.1f} "
            f"{s.predicted_price:10.2f} {s.unit_risk:7.3f} {s.predicted_defect_rate*100:6.2f}% {s.predicted_capacity_util:6.3f}"
        )
    print()
    rows = [*solved, single, even]
    print(
        f"{'strategy':<20} {'λ':>5} {'cost':>12} {'risk':>7} "
        f"{'vs cheap $':>11} {'vs cheap R':>11} {'vs even $':>10} {'vs even R':>10}  allocation"
    )
    for a in rows:
        dc = pct_impr(a.expected_cost, single.expected_cost)
        dr = pct_impr(a.expected_risk, single.expected_risk)
        ec = pct_impr(a.expected_cost, even.expected_cost)
        er = pct_impr(a.expected_risk, even.expected_risk)
        bits = ", ".join(f"{n}={q:.1f}" for n, q in a.qty_named(suppliers).items()) or "—"
        print(
            f"{a.label:<20} {a.risk_weight:5.2f} {a.expected_cost:12.1f} {a.expected_risk:7.3f} "
            f"{fmt_pct(dc):>11} {fmt_pct(dr):>11} {fmt_pct(ec):>10} {fmt_pct(er):>10}  {bits}"
        )
    print("  % = (baseline - strategy) / baseline; positive = cheaper or less risky.")


def strategies_sql(
    run_id: str,
    solved: list[Allocation],
    suppliers_by_cat: dict[str, list[SupplierOpt]],
    baselines: dict[str, tuple[Allocation, Allocation]],
) -> str:
    lines = [
        "-- PuLP allocation sweep. Generated by scripts/optimize_allocation.py",
        f"-- run_id {run_id}",
    ]
    values = []
    for a in solved:
        if a.status != "Optimal":
            continue
        single, even = baselines[a.category]
        payload = allocation_json(a, suppliers_by_cat[a.category], run_id, single, even)
        js = json.dumps(payload).replace("'", "''")
        values.append(
            f"  ('{run_id}'::uuid, {a.risk_weight}, '{js}'::jsonb, {a.expected_cost:.6f}, {a.expected_risk:.6f})"
        )
    if not values:
        return "-- no optimal strategies to insert\n"
    lines.append(
        """insert into public.strategies (run_id, risk_weight, allocation_json, expected_cost, expected_risk)
values"""
    )
    lines.append(",\n".join(values) + ";")
    lines.append(
        f"""
insert into public.decisions (
  related_entity_type, related_entity_id, decision_text, reasoning, made_by
)
select
  'strategy',
  s.id,
  'PuLP allocation ' || (s.allocation_json->>'label') || ' / ' || (s.allocation_json->>'category'),
  s.allocation_json->>'objective',
  'agent'::public.decision_maker
from public.strategies s
where s.run_id = '{run_id}'::uuid;
"""
    )
    return "\n".join(lines) + "\n"


def parse_demand(pairs: list[str] | None) -> dict[str, float]:
    demand = dict(DEFAULT_DEMAND)
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"demand must be category=qty, got {item}")
        cat, qty = item.split("=", 1)
        if cat not in CATEGORIES:
            raise SystemExit(f"unknown category {cat}; expected {CATEGORIES}")
        demand[cat] = float(qty)
    return demand


def optimize_category(
    suppliers: list[SupplierOpt],
    demand: float,
    sweep: tuple[tuple[str, float], ...] = SWEEP,
) -> tuple[list[Allocation], Allocation, Allocation]:
    """Callable per category. Returns (sweep allocations, single baseline, even baseline)."""
    attach_risk(suppliers)
    solved = [solve_pulp(suppliers, demand, w, label) for label, w in sweep]
    single = baseline_single_cheapest(suppliers, demand)
    even = baseline_even_split(suppliers, demand)
    return solved, single, even


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="Forecast+supplier rows (list of objects).")
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--category", choices=CATEGORIES, help="Run one category (default: all).")
    parser.add_argument("--demand", action="append", metavar="CAT=QTY", help="Repeatable. Default D2C cycle sizes.")
    parser.add_argument("--write-sql", type=Path)
    args = parser.parse_args()
    if bool(args.json) == bool(args.csv):
        print("pass exactly one of --json or --csv", file=sys.stderr)
        return 1

    suppliers = load_json(args.json) if args.json else load_csv(args.csv)
    demand_map = parse_demand(args.demand)
    cats = [args.category] if args.category else list(CATEGORIES)
    run_id = str(uuid.uuid4())
    all_solved: list[Allocation] = []
    by_cat: dict[str, list[SupplierOpt]] = {}
    baselines: dict[str, tuple[Allocation, Allocation]] = {}

    print("PuLP CBC  |  obj = Σ (price + λ·median_price·unit_risk)·qty")
    print(f"run_id={run_id}")
    print("Baselines are returned for the dashboard; only the λ sweep is written to strategies.")

    for cat in cats:
        group = [s for s in suppliers if s.category == cat]
        if not group:
            print(f"skip {cat}: no rows", file=sys.stderr)
            continue
        group.sort(key=lambda s: s.name)
        by_cat[cat] = group
        demand = demand_map[cat]
        solved, single, even = optimize_category(group, demand)
        all_solved.extend(solved)
        baselines[cat] = (single, even)
        print_category_report(cat, demand, group, solved, single, even)

    if args.write_sql:
        args.write_sql.write_text(strategies_sql(run_id, all_solved, by_cat, baselines))
        print(f"\nwrote {args.write_sql}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
