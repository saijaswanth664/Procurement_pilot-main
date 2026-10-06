from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))

from optimize_allocation import (  # noqa: E402
    DEFAULT_DEMAND,
    allocation_json,
    optimize_category,
    parse_rows,
    pct_impr,
)


def main() -> None:
    rows = json.loads(Path(sys.argv[1]).read_text())
    suppliers = parse_rows(rows)
    by_cat: dict[str, list] = {}
    for s in suppliers:
        by_cat.setdefault(s.category, []).append(s)

    print("=== RAW LATEST FORECAST POOL ===")
    for s in suppliers:
        print(
            f"  {s.id:>2} {s.category:<24} {s.name:<28} open={s.open} "
            f"moq={s.moq:g} avail={s.available:.1f} price={s.predicted_price:.4f}"
        )

    for cat, group in by_cat.items():
        demand = DEFAULT_DEMAND[cat]
        solved, single, even = optimize_category(group, demand)
        print(f"\n=== {cat} demand={demand:g} ===")
        for a in solved:
            bits = ", ".join(f"{n}={q:.1f}" for n, q in a.qty_named(group).items()) or "—"
            print(
                f"  λ={a.risk_weight:<4} {a.label:<18} cost={a.expected_cost:.4f} "
                f"risk={a.expected_risk:.6f}  {bits}"
            )
        print(
            f"  baseline single_cheapest cost={single.expected_cost:.4f} "
            f"risk={single.expected_risk:.6f} {single.qty_named(group)}"
        )
        print(
            f"  baseline even_split      cost={even.expected_cost:.4f} "
            f"risk={even.expected_risk:.6f} {even.qty_named(group)}"
        )
        for a in solved:
            if a.label == "balanced":
                print(
                    "  balanced vs even cost "
                    f"{pct_impr(a.expected_cost, even.expected_cost)} "
                    "vs cheap "
                    f"{pct_impr(a.expected_cost, single.expected_cost)}"
                )
                payload = allocation_json(a, group, "backfill", single, even)
                Path(f"/tmp/baselines_{cat}.json").write_text(json.dumps(payload["baselines"], indent=2))
                Path(f"/tmp/impr_{cat}.json").write_text(json.dumps(payload["improvement_pct"], indent=2))


if __name__ == "__main__":
    main()
