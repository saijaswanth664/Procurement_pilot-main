#!/usr/bin/env python3
"""
Push seed data to Supabase using the REST API.
Uses service role key to bypass RLS for seeding.

Usage:
  set SUPABASE_URL=https://xxxx.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
  python scripts/push_seed_to_supabase.py
"""
import httpx
import os
import sys

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ofrvwvfidmnqurcwvlui.supabase.co")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SERVICE_KEY:
    print("ERROR: Set SUPABASE_SERVICE_ROLE_KEY env var before running.")
    sys.exit(1)

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=merge-duplicates",
}

SUPPLIERS = [
    {"name": "Himalaya Roots Co-op",        "category": "raw_herbs",              "region": "Uttarakhand",  "moq": 50,   "max_capacity": 1200,  "active_since": "2021-04-12"},
    {"name": "Deccan Gold Botanicals",       "category": "raw_herbs",              "region": "Karnataka",    "moq": 25,   "max_capacity": 2200,  "active_since": "2023-11-03"},
    {"name": "Malabar Amla Groves",          "category": "raw_herbs",              "region": "Kerala",       "moq": 40,   "max_capacity": 900,   "active_since": "2022-01-18"},
    {"name": "Khejri Neem Traders",          "category": "raw_herbs",              "region": "Rajasthan",    "moq": 30,   "max_capacity": 800,   "active_since": "2020-08-01"},
    {"name": "PackLite Mumbai",              "category": "packaging",              "region": "Maharashtra",  "moq": 2000, "max_capacity": 80000, "active_since": "2019-06-20"},
    {"name": "LabelCraft Pune",              "category": "packaging",              "region": "Maharashtra",  "moq": 5000, "max_capacity": 200000,"active_since": "2022-09-09"},
    {"name": "Saurashtra GlassWorks",        "category": "packaging",              "region": "Gujarat",      "moq": 1000, "max_capacity": 40000, "active_since": "2018-02-14"},
    {"name": "AyurForm CMO Hyderabad",       "category": "contract_manufacturing", "region": "Telangana",    "moq": 5000, "max_capacity": 60000, "active_since": "2021-12-01"},
    {"name": "Nilgiri Herb Processors",      "category": "contract_manufacturing", "region": "Tamil Nadu",   "moq": 3000, "max_capacity": 45000, "active_since": "2020-03-22"},
]

def upsert(client: httpx.Client, table: str, rows: list[dict]) -> None:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    # Use Prefer: resolution=merge-duplicates for upsert
    headers = {**HEADERS, "Prefer": "return=minimal,resolution=merge-duplicates"}
    resp = client.post(url, json=rows, headers=headers)
    if resp.status_code not in (200, 201, 204):
        print(f"  ERROR {resp.status_code}: {resp.text[:300]}")
        sys.exit(1)
    print(f"  ✅ Upserted {len(rows)} rows into {table}")

def main():
    print("🌱 Seeding AyuraNest suppliers into Supabase...\n")
    with httpx.Client(timeout=30) as client:
        # ── Step 1: Upsert suppliers ─────────────────────────────────────
        print("📦 Inserting 9 suppliers...")
        upsert(client, "suppliers", SUPPLIERS)

        # ── Step 2: Fetch supplier IDs ────────────────────────────────────
        print("\n🔍 Fetching supplier IDs...")
        resp = client.get(
            f"{SUPABASE_URL}/rest/v1/suppliers?select=id,name",
            headers=HEADERS,
        )
        if resp.status_code != 200:
            print(f"  ERROR fetching suppliers: {resp.text}")
            sys.exit(1)
        suppliers_db = {row["name"]: row["id"] for row in resp.json()}
        print(f"  Found {len(suppliers_db)} suppliers: {list(suppliers_db.keys())}")

        # ── Step 3: Generate and push metrics ────────────────────────────
        print("\n📊 Generating 180-day metrics per supplier...")
        import random, math
        from datetime import date, timedelta

        SEED = 42
        DAYS = 180
        AS_OF = date(2026, 8, 28)
        rng = random.Random(SEED)
        start = AS_OF - timedelta(days=DAYS - 1)

        specs = [
            ("Himalaya Roots Co-op",    640,  4.0,  (),           1.0,  0.011, 0.0015, 0.0,   8.5,  0.4,  True,  0.52, 0.58, 0.03),
            ("Deccan Gold Botanicals",  148,  6.5,  (42,43,44,118,119), 1.38, 0.048, 0.012,  0.022, 16.0, 2.2,  True,  0.70, 0.78, 0.08),
            ("Malabar Amla Groves",     118,  3.0,  (91,),        1.18, 0.019, 0.003,  0.004, 12.0, 0.8,  True,  0.48, 0.61, 0.04),
            ("Khejri Neem Traders",     72,   2.2,  (),           1.0,  0.016, 0.0025, 0.045, 10.0, 0.6,  False, 0.44, 0.50, 0.03),
            ("PackLite Mumbai",         11.8, 0.12, (55,56,57),   1.22, 0.007, 0.0012, 0.0,   7.0,  0.35, False, 0.55, 0.62, 0.04),
            ("LabelCraft Pune",         2.35, 0.04, (),           1.0,  0.012, 0.002,  0.008, 5.0,  0.25, False, 0.40, 0.47, 0.03),
            ("Saurashtra GlassWorks",   16.4, 0.18, (160,),       1.09, 0.009, 0.001,  -0.001,12.0, 0.5,  False, 0.50, 0.54, 0.03),
            ("AyurForm CMO Hyderabad",  17.5, 0.15, (),           1.0,  0.021, 0.003,  0.006, 18.0, 0.7,  False, 0.62, 0.94, 0.02),
            ("Nilgiri Herb Processors", 21.2, 0.10, (),           1.0,  0.010, 0.0012, 0.0,   16.0, 0.35, False, 0.46, 0.51, 0.025),
        ]

        def clamp(x, lo, hi): return max(lo, min(hi, x))

        def monsoon_factor(d, sensitive):
            f = 1.0
            if date(2026, 3, 1) <= d <= date(2026, 3, 8):
                f *= 1.32 if sensitive else 1.12
            if date(2026, 3, 18) <= d <= date(2026, 3, 26):
                f *= 1.18 if sensitive else 1.08
            if d.month in (6, 7, 8) and sensitive:
                f *= 1.12 + 0.10 * ((d.month - 6) + d.day / 31.0) / 3.0
            elif d.month in (6, 7, 8):
                f *= 1.04
            return f

        CHUNK = 500  # rows per API call
        total_metrics = 0

        for (name, pb, ps, shocks, smult, db, dn, dd, lb, ln, ms, us, ue, un) in specs:
            sid = suppliers_db.get(name)
            if not sid:
                print(f"  ⚠️  Supplier '{name}' not found in DB — skipping metrics")
                continue

            rows = []
            price = pb
            for i in range(DAYS):
                d = start + timedelta(days=i)
                t = i / max(DAYS - 1, 1)
                price += rng.gauss(0, ps)
                shock = smult if i in shocks else 1.0
                day_price = clamp(price * shock, pb * 0.55, pb * 2.2)
                defect = clamp(db + dd * t + rng.gauss(0, dn), 0.001, 0.18)
                if name == "Deccan Gold Botanicals" and rng.random() < 0.04:
                    defect += 0.035
                defect = clamp(defect, 0.001, 0.18)
                lead = clamp(lb + rng.gauss(0, ln), 3.0, 45.0) * monsoon_factor(d, ms)
                lead = clamp(lead, 3.0, 45.0)
                util = clamp(us + (ue - us) * t + rng.gauss(0, un), 0.15, 0.99)
                cap = (1200 if name == "Himalaya Roots Co-op" else
                       2200 if name == "Deccan Gold Botanicals" else
                       900  if name == "Malabar Amla Groves" else
                       800  if name == "Khejri Neem Traders" else
                       80000 if name == "PackLite Mumbai" else
                       200000 if name == "LabelCraft Pune" else
                       40000 if name == "Saurashtra GlassWorks" else
                       60000 if name == "AyurForm CMO Hyderabad" else
                       45000) / 30.0 * util

                rows.append({
                    "supplier_id": sid,
                    "date": d.isoformat(),
                    "price": round(day_price, 4),
                    "defect_rate": round(defect, 5),
                    "lead_time_days": round(lead, 3),
                    "capacity_used": round(cap, 4),
                    "source": "synthetic",
                })

            # Push in chunks
            for off in range(0, len(rows), CHUNK):
                chunk = rows[off:off+CHUNK]
                upsert(client, "supplier_metrics", chunk)
                total_metrics += len(chunk)
            print(f"  ✅ {name}: {len(rows)} metric rows pushed")

        print(f"\n🎉 Done! Total metric rows inserted: {total_metrics}")
        print("   Open http://localhost:5173 and log in to see the dashboard!")

if __name__ == "__main__":
    main()
