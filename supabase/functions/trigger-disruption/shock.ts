import { type Supplier, refreshOpen } from "./optimize.ts";

function bumpStd(
  unc: Record<string, { std?: number }>,
  key: string,
  factor: number,
): void {
  const block = { ...(unc[key] ?? {}) };
  block.std = (block.std ?? 0) * factor;
  unc[key] = block;
}

export function cloneSupplier(s: Supplier): Supplier {
  return {
    ...s,
    uncertainty: JSON.parse(JSON.stringify(s.uncertainty ?? {})),
  };
}

export function applyShock(
  src: Supplier,
  dtype: string,
  magnitudePct: number,
): Supplier {
  const m = magnitudePct / 100;
  if (m < 0) throw new Error("magnitude must be >= 0");
  const s = cloneSupplier(src);
  if (dtype === "price") {
    s.predicted_price = s.predicted_price * (1 + m);
    bumpStd(s.uncertainty, "price", 1 + 0.5 * m);
  } else if (dtype === "capacity") {
    const slack = Math.max(0, 0.999 - s.predicted_capacity_util);
    s.predicted_capacity_util = Math.min(0.999, s.predicted_capacity_util + slack * m);
    s.util_std = s.util_std * (1 + 0.5 * m);
    bumpStd(s.uncertainty, "capacity_util", 1 + 0.5 * m);
  } else if (dtype === "reliability") {
    s.predicted_defect_rate = Math.min(0.25, s.predicted_defect_rate * (1 + m));
    s.predicted_lead_time = Math.min(45, s.predicted_lead_time * (1 + 0.5 * m));
    s.predicted_reliability = Math.max(0.05, s.predicted_reliability * (1 - m));
    s.defect_std = s.defect_std * (1 + m);
    s.lead_std = s.lead_std * (1 + m);
    bumpStd(s.uncertainty, "defect_rate", 1 + m);
    bumpStd(s.uncertainty, "lead_time", 1 + m);
    bumpStd(s.uncertainty, "reliability", 1 + m);
  } else {
    throw new Error("type must be price|capacity|reliability");
  }
  refreshOpen(s);
  return s;
}

export function makeBookable(s: Supplier, demand: number): Supplier {
  const need = Math.min(s.max_capacity * 0.2, Math.max(s.moq, demand));
  if (s.available + 1e-9 >= need) return s;
  const out = cloneSupplier(s);
  out.predicted_capacity_util = Math.max(0.5, 1 - need / out.max_capacity);
  refreshOpen(out);
  return out;
}
