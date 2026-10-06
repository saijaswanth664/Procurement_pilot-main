#!/usr/bin/env python3
"""Idempotent AyuraNest synthetic suppliers + 180-day metrics.

Safe to rerun: upserts suppliers by unique name, then upserts metrics on
(supplier_id, date). Prints SQL on stdout for MCP/CLI, or --write PATH.

  python scripts/seed_ayuranest_suppliers.py --write /tmp/ayuranest_seed.sql
"""

from __future__ import annotations

import argparse
import math
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

SEED = 42
DAYS = 180
AS_OF = date(2026, 8, 28)


@dataclass(frozen=True)
class SupplierSpec:
    name: str
    category: str
    region: str
    moq: float
    max_capacity: float
    active_since: str
    # price
    price_base: float
    price_sigma: float
    price_shock_days: tuple[int, ...]
    price_shock_mult: float
    # defect (rate 0-1)
    defect_base: float
    defect_noise: float
    defect_drift: float  # added linearly over the series (degradation)
    # lead time
    lead_base: float
    lead_noise: float
    monsoon_sensitive: bool
    # capacity: daily units, end-of-series utilization of monthly max
    util_start: float
    util_end: float
    util_noise: float


# 9 suppliers: 4 herbs, 3 packaging, 2 CMO.
# Himalaya Roots = cautious/dependable (higher price, tight defect, stable LT).
# Deccan Gold = confident/unreliable (cheap, dirty, late, jumpy).
SUPPLIERS: tuple[SupplierSpec, ...] = (
    SupplierSpec(
        name="Himalaya Roots Co-op",
        category="raw_herbs",
        region="Uttarakhand",
        moq=50,
        max_capacity=1200,
        active_since="2021-04-12",
        price_base=640,  # ashwagandha INR/kg — premium
        price_sigma=4.0,
        price_shock_days=(),
        price_shock_mult=1.0,
        defect_base=0.011,
        defect_noise=0.0015,
        defect_drift=0.0,
        lead_base=8.5,
        lead_noise=0.4,
        monsoon_sensitive=True,
        util_start=0.52,
        util_end=0.58,
        util_noise=0.03,
    ),
    SupplierSpec(
        name="Deccan Gold Botanicals",
        category="raw_herbs",
        region="Karnataka",
        moq=25,
        max_capacity=2200,
        active_since="2023-11-03",
        price_base=148,  # turmeric INR/kg — discounter
        price_sigma=6.5,
        price_shock_days=(42, 43, 44, 118, 119),
        price_shock_mult=1.38,
        defect_base=0.048,
        defect_noise=0.012,
        defect_drift=0.022,
        lead_base=16.0,
        lead_noise=2.2,
        monsoon_sensitive=True,
        util_start=0.70,
        util_end=0.78,
        util_noise=0.08,
    ),
    SupplierSpec(
        name="Malabar Amla Groves",
        category="raw_herbs",
        region="Kerala",
        moq=40,
        max_capacity=900,
        active_since="2022-01-18",
        price_base=118,
        price_sigma=3.0,
        price_shock_days=(91,),
        price_shock_mult=1.18,
        defect_base=0.019,
        defect_noise=0.003,
        defect_drift=0.004,
        lead_base=12.0,
        lead_noise=0.8,
        monsoon_sensitive=True,
        util_start=0.48,
        util_end=0.61,
        util_noise=0.04,
    ),
    SupplierSpec(
        name="Khejri Neem Traders",
        category="raw_herbs",
        region="Rajasthan",
        moq=30,
        max_capacity=800,
        active_since="2020-08-01",
        price_base=72,
        price_sigma=2.2,
        price_shock_days=(),
        price_shock_mult=1.0,
        defect_base=0.016,
        defect_noise=0.0025,
        defect_drift=0.045,  # visible quality slide
        lead_base=10.0,
        lead_noise=0.6,
        monsoon_sensitive=False,  # dry belt; monsoon less of a dispatch issue
        util_start=0.44,
        util_end=0.50,
        util_noise=0.03,
    ),
    SupplierSpec(
        name="PackLite Mumbai",
        category="packaging",
        region="Maharashtra",
        moq=2000,
        max_capacity=80000,
        active_since="2019-06-20",
        price_base=11.8,  # PET bottle INR/unit
        price_sigma=0.12,
        price_shock_days=(55, 56, 57),  # resin spike
        price_shock_mult=1.22,
        defect_base=0.007,
        defect_noise=0.0012,
        defect_drift=0.0,
        lead_base=7.0,
        lead_noise=0.35,
        monsoon_sensitive=False,
        util_start=0.55,
        util_end=0.62,
        util_noise=0.04,
    ),
    SupplierSpec(
        name="LabelCraft Pune",
        category="packaging",
        region="Maharashtra",
        moq=5000,
        max_capacity=200000,
        active_since="2022-09-09",
        price_base=2.35,
        price_sigma=0.04,
        price_shock_days=(),
        price_shock_mult=1.0,
        defect_base=0.012,
        defect_noise=0.002,
        defect_drift=0.008,  # ink/adhesion complaints creeping up
        lead_base=5.0,
        lead_noise=0.25,
        monsoon_sensitive=False,
        util_start=0.40,
        util_end=0.47,
        util_noise=0.03,
    ),
    SupplierSpec(
        name="Saurashtra GlassWorks",
        category="packaging",
        region="Gujarat",
        moq=1000,
        max_capacity=40000,
        active_since="2018-02-14",
        price_base=16.4,
        price_sigma=0.18,
        price_shock_days=(160,),
        price_shock_mult=1.09,
        defect_base=0.009,
        defect_noise=0.001,
        defect_drift=-0.001,
        lead_base=12.0,
        lead_noise=0.5,
        monsoon_sensitive=False,
        util_start=0.50,
        util_end=0.54,
        util_noise=0.03,
    ),
    SupplierSpec(
        name="AyurForm CMO Hyderabad",
        category="contract_manufacturing",
        region="Telangana",
        moq=5000,
        max_capacity=60000,
        active_since="2021-12-01",
        price_base=17.5,
        price_sigma=0.15,
        price_shock_days=(),
        price_shock_mult=1.0,
        defect_base=0.021,
        defect_noise=0.003,
        defect_drift=0.006,
        lead_base=18.0,
        lead_noise=0.7,
        monsoon_sensitive=False,
        util_start=0.62,
        util_end=0.94,  # approaching ceiling — capacity-cut demo setup
        util_noise=0.02,
    ),
    SupplierSpec(
        name="Nilgiri Herb Processors",
        category="contract_manufacturing",
        region="Tamil Nadu",
        moq=3000,
        max_capacity=45000,
        active_since="2020-03-22",
        price_base=21.2,  # dearer, quieter
        price_sigma=0.10,
        price_shock_days=(),
        price_shock_mult=1.0,
        defect_base=0.010,
        defect_noise=0.0012,
        defect_drift=0.0,
        lead_base=16.0,
        lead_noise=0.35,
        monsoon_sensitive=False,
        util_start=0.46,
        util_end=0.51,
        util_noise=0.025,
    ),
)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def india_dispatch_factor(d: date, herb_sensitive: bool) -> float:
    """Lead-time multiplier: Holi, Eid, and SW monsoon (Jun–Aug in this window)."""
    factor = 1.0
    # Holi 2026 ~ 3 Mar
    if date(2026, 3, 1) <= d <= date(2026, 3, 8):
        factor *= 1.32 if herb_sensitive else 1.12
    # Eid al-Fitr 2026 ~ 20 Mar
    if date(2026, 3, 18) <= d <= date(2026, 3, 26):
        factor *= 1.18 if herb_sensitive else 1.08
    # Southwest monsoon logistics for India-sourced herbs
    if d.month in (6, 7, 8) and herb_sensitive:
        # worsens into late monsoon (Aug)
        factor *= 1.12 + 0.10 * ((d.month - 6) + d.day / 31.0) / 3.0
    elif d.month in (6, 7, 8):
        factor *= 1.04
    return factor


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def generate_sql() -> str:
    rng = random.Random(SEED)
    start = AS_OF - timedelta(days=DAYS - 1)
    lines: list[str] = [
        "-- AyuraNest synthetic seed (idempotent). Generated by scripts/seed_ayuranest_suppliers.py",
        """insert into public.suppliers (name, category, region, moq, max_capacity, active_since)
values""",
    ]
    value_rows = []
    for s in SUPPLIERS:
        value_rows.append(
            f"  ({sql_literal(s.name)}, {sql_literal(s.category)}, {sql_literal(s.region)}, "
            f"{s.moq}, {s.max_capacity}, {sql_literal(s.active_since)}::date)"
        )
    lines.append(",\n".join(value_rows))
    lines.append(
        """on conflict (name) do update set
  category = excluded.category,
  region = excluded.region,
  moq = excluded.moq,
  max_capacity = excluded.max_capacity,
  active_since = excluded.active_since;"""
    )

    metric_rows: list[str] = []
    for spec in SUPPLIERS:
        price = spec.price_base
        for i in range(DAYS):
            d = start + timedelta(days=i)
            t = i / max(DAYS - 1, 1)
            price += rng.gauss(0, spec.price_sigma)
            if spec.category == "raw_herbs":
                price *= 1.0 + 0.00015  # slow inflation
            shock = spec.price_shock_mult if i in spec.price_shock_days else 1.0
            day_price = clamp(price * shock, spec.price_base * 0.55, spec.price_base * 2.2)

            defect = spec.defect_base + spec.defect_drift * t + rng.gauss(0, spec.defect_noise)
            if spec.name == "Deccan Gold Botanicals" and rng.random() < 0.04:
                defect += 0.035  # random QC blow-ups
            defect = clamp(defect, 0.001, 0.18)

            lead = spec.lead_base + rng.gauss(0, spec.lead_noise)
            lead *= india_dispatch_factor(d, spec.monsoon_sensitive)
            lead = clamp(lead, 3.0, 45.0)

            util = spec.util_start + (spec.util_end - spec.util_start) * t
            util += rng.gauss(0, spec.util_noise)
            util = clamp(util, 0.15, 0.99)
            daily_capacity = spec.max_capacity / 30.0 * util

            metric_rows.append(
                "  ("
                f"(select id from public.suppliers where name = {sql_literal(spec.name)}), "
                f"{sql_literal(d.isoformat())}::date, "
                f"{day_price:.4f}, {defect:.5f}, {lead:.3f}, {daily_capacity:.4f}, "
                f"'synthetic'::public.metric_source)"
            )

    # Chunked inserts keep statements under typical MCP payload limits.
    chunk = 200
    for offset in range(0, len(metric_rows), chunk):
        batch = metric_rows[offset : offset + chunk]
        lines.append(
            """insert into public.supplier_metrics
  (supplier_id, date, price, defect_rate, lead_time_days, capacity_used, source)
values"""
        )
        lines.append(",\n".join(batch))
        lines.append(
            """on conflict (supplier_id, date) do update set
  price = excluded.price,
  defect_rate = excluded.defect_rate,
  lead_time_days = excluded.lead_time_days,
  capacity_used = excluded.capacity_used,
  source = excluded.source;"""
        )

    return "\n".join(lines) + "\n"


def compact_metric_sql() -> list[tuple[str, str]]:
    """One unnest-insert per supplier (smaller MCP payloads)."""
    rng = random.Random(SEED)
    start = AS_OF - timedelta(days=DAYS - 1)
    out: list[tuple[str, str]] = []
    for spec in SUPPLIERS:
        dates: list[str] = []
        prices: list[str] = []
        defects: list[str] = []
        leads: list[str] = []
        caps: list[str] = []
        price = spec.price_base
        for i in range(DAYS):
            d = start + timedelta(days=i)
            t = i / max(DAYS - 1, 1)
            price += rng.gauss(0, spec.price_sigma)
            if spec.category == "raw_herbs":
                price *= 1.0 + 0.00015
            shock = spec.price_shock_mult if i in spec.price_shock_days else 1.0
            day_price = clamp(price * shock, spec.price_base * 0.55, spec.price_base * 2.2)
            defect = spec.defect_base + spec.defect_drift * t + rng.gauss(0, spec.defect_noise)
            if spec.name == "Deccan Gold Botanicals" and rng.random() < 0.04:
                defect += 0.035
            defect = clamp(defect, 0.001, 0.18)
            lead = spec.lead_base + rng.gauss(0, spec.lead_noise)
            lead *= india_dispatch_factor(d, spec.monsoon_sensitive)
            lead = clamp(lead, 3.0, 45.0)
            util = spec.util_start + (spec.util_end - spec.util_start) * t
            util += rng.gauss(0, spec.util_noise)
            util = clamp(util, 0.15, 0.99)
            daily_capacity = spec.max_capacity / 30.0 * util
            dates.append(f"'{d.isoformat()}'::date")
            prices.append(f"{day_price:.4f}")
            defects.append(f"{defect:.5f}")
            leads.append(f"{lead:.3f}")
            caps.append(f"{daily_capacity:.4f}")
        sql = f"""insert into public.supplier_metrics
  (supplier_id, date, price, defect_rate, lead_time_days, capacity_used, source)
select
  (select id from public.suppliers where name = {sql_literal(spec.name)}),
  t.d, t.p, t.df, t.lt, t.cu,
  'synthetic'::public.metric_source
from unnest(
  ARRAY[{",".join(dates)}],
  ARRAY[{",".join(prices)}]::numeric[],
  ARRAY[{",".join(defects)}]::numeric[],
  ARRAY[{",".join(leads)}]::numeric[],
  ARRAY[{",".join(caps)}]::numeric[]
) as t(d, p, df, lt, cu)
on conflict (supplier_id, date) do update set
  price = excluded.price,
  defect_rate = excluded.defect_rate,
  lead_time_days = excluded.lead_time_days,
  capacity_used = excluded.capacity_used,
  source = excluded.source;"""
        out.append((spec.name, sql))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", type=Path)
    parser.add_argument("--compact-dir", type=Path)
    args = parser.parse_args()
    if args.compact_dir:
        args.compact_dir.mkdir(parents=True, exist_ok=True)
        for i, (name, sql) in enumerate(compact_metric_sql(), start=1):
            slug = f"{i:02d}_" + "".join(c if c.isalnum() else "_" for c in name.lower())
            path = args.compact_dir / f"{slug}.sql"
            path.write_text(sql)
            print(f"wrote {path} ({len(sql)} bytes)")
        return
    sql = generate_sql()
    if args.write:
        args.write.write_text(sql)
        print(f"wrote {args.write} ({len(sql)} bytes)")
    else:
        print(sql)


if __name__ == "__main__":
    main()
