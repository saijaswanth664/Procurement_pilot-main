/** Same MILP as scripts/optimize_allocation.py: enumerate who is used, then fill cheapest effective cost. */

export const LATE_ANCHOR = 0.5;
export const QUAL_ANCHOR = 0.02;
export const CAP_ANCHOR = 2.0;
export const W_LATE = 0.4;
export const W_QUAL = 0.4;
export const W_CAP = 0.2;

export const SWEEP: [string, number][] = [
  ["cost_aggressive", 0],
  ["balanced", 0.7],
  ["risk_averse", 4],
];

export const DEFAULT_DEMAND: Record<string, number> = {
  raw_herbs: 350,
  packaging: 18000,
  contract_manufacturing: 8000,
};

export type Supplier = {
  id: number;
  name: string;
  category: string;
  moq: number;
  max_capacity: number;
  predicted_price: number;
  predicted_lead_time: number;
  predicted_defect_rate: number;
  predicted_capacity_util: number;
  predicted_reliability: number;
  lead_std: number;
  defect_std: number;
  util_std: number;
  uncertainty: Record<string, { std?: number }>;
  available: number;
  unit_risk: number;
  open: boolean;
};

export type Allocation = {
  label: string;
  risk_weight: number;
  demand: number;
  category: string;
  qty: Record<number, number>;
  expected_cost: number;
  expected_risk: number;
  status: string;
  notes: string;
};

export function forecastAvailable(maxCapacity: number, util: number): number {
  const u = Math.min(Math.max(util, 0), 0.999);
  return Math.max(0, maxCapacity * (1 - u));
}

export function refreshOpen(s: Supplier): void {
  s.available = forecastAvailable(s.max_capacity, s.predicted_capacity_util);
  s.open = s.available + 1e-9 >= s.moq;
}

export function attachRisk(suppliers: Supplier[]): void {
  for (const s of suppliers) {
    const capStress = s.predicted_capacity_util /
      Math.max(1e-3, 1 - Math.min(s.predicted_capacity_util, 0.999));
    s.unit_risk = W_LATE * (s.lead_std / LATE_ANCHOR) +
      W_QUAL * ((s.predicted_defect_rate + s.defect_std) / QUAL_ANCHOR) +
      W_CAP * (capStress / CAP_ANCHOR);
    refreshOpen(s);
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}

function costRisk(suppliers: Supplier[], qty: Record<number, number>): [number, number] {
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  let totalQ = 0;
  let cost = 0;
  let riskNum = 0;
  for (const [idStr, q] of Object.entries(qty)) {
    const s = byId.get(Number(idStr))!;
    totalQ += q;
    cost += s.predicted_price * q;
    riskNum += s.unit_risk * q;
  }
  return [cost, totalQ <= 1e-9 ? 0 : riskNum / totalQ];
}

function solveEnum(
  suppliers: Supplier[],
  demand: number,
  riskWeight: number,
  label: string,
): Allocation {
  const cat = suppliers[0]!.category;
  const open = suppliers.filter((s) => s.open);
  if (!open.length) {
    return {
      label,
      risk_weight: riskWeight,
      demand,
      category: cat,
      qty: {},
      expected_cost: 0,
      expected_risk: 0,
      status: "Infeasible",
      notes: "no supplier with available ≥ moq",
    };
  }
  const totalAvail = open.reduce((a, s) => a + s.available, 0);
  if (demand > totalAvail + 1e-6) {
    return {
      label,
      risk_weight: riskWeight,
      demand,
      category: cat,
      qty: {},
      expected_cost: 0,
      expected_risk: 0,
      status: "Infeasible",
      notes: `demand ${demand} > total available ${totalAvail}`,
    };
  }
  const medianPrice = median(open.map((s) => s.predicted_price));
  const n = open.length;
  let bestObj = Infinity;
  let bestQty: Record<number, number> | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = open.filter((_, i) => (mask & (1 << i)) !== 0);
    const moqSum = subset.reduce((a, s) => a + s.moq, 0);
    const capSum = subset.reduce((a, s) => a + s.available, 0);
    if (moqSum > demand + 1e-9 || capSum < demand - 1e-9) continue;
    const qty: Record<number, number> = {};
    for (const s of subset) qty[s.id] = s.moq;
    let leftover = demand - moqSum;
    const order = [...subset].sort((a, b) => {
      const ca = a.predicted_price + riskWeight * medianPrice * a.unit_risk;
      const cb = b.predicted_price + riskWeight * medianPrice * b.unit_risk;
      return ca - cb;
    });
    for (const s of order) {
      if (leftover <= 1e-12) break;
      const room = s.available - qty[s.id]!;
      const take = Math.min(room, leftover);
      qty[s.id]! += take;
      leftover -= take;
    }
    if (leftover > 1e-6) continue;
    const obj = subset.reduce(
      (a, s) => a + (s.predicted_price + riskWeight * medianPrice * s.unit_risk) * qty[s.id]!,
      0,
    );
    if (obj < bestObj - 1e-9) {
      bestObj = obj;
      bestQty = qty;
    }
  }
  if (!bestQty) {
    return {
      label,
      risk_weight: riskWeight,
      demand,
      category: cat,
      qty: {},
      expected_cost: 0,
      expected_risk: 0,
      status: "Infeasible",
      notes: "no feasible subset",
    };
  }
  const cleaned: Record<number, number> = {};
  for (const [k, v] of Object.entries(bestQty)) {
    if (v > 1e-6) cleaned[Number(k)] = v;
  }
  const [cost, risk] = costRisk(suppliers, cleaned);
  return {
    label,
    risk_weight: riskWeight,
    demand,
    category: cat,
    qty: cleaned,
    expected_cost: cost,
    expected_risk: risk,
    status: "Optimal",
    notes:
      `min Σ (price + ${riskWeight} * median_price(${medianPrice.toFixed(2)}) * unit_risk) * qty; ` +
      `qty=0 or moq≤qty≤available; available=max_capacity*(1-predicted_capacity_util)`,
  };
}

export function baselineSingleCheapest(suppliers: Supplier[], demand: number): Allocation {
  const cat = suppliers[0]!.category;
  const openS = suppliers.filter((s) => s.open);
  const fillers = openS.filter((s) => s.available + 1e-9 >= demand && demand + 1e-9 >= s.moq);
  let qmap: Record<number, number> = {};
  let note: string;
  let status: string;
  if (fillers.length) {
    const pick = fillers.reduce((a, b) => (a.predicted_price < b.predicted_price ? a : b));
    qmap = { [pick.id]: demand };
    note = `single supplier ${pick.name} (cheapest who can fill ${demand})`;
    status = "Baseline";
  } else if (openS.length) {
    const pick = openS.reduce((a, b) => (a.predicted_price < b.predicted_price ? a : b));
    const q = Math.min(demand, pick.available);
    qmap = q + 1e-9 >= pick.moq ? { [pick.id]: q } : {};
    note = `single supplier ${pick.name} cannot fill ${demand}; allocated ${q.toFixed(1)}`;
    status = "Baseline-shortfall";
  } else {
    return {
      label: "single_cheapest",
      risk_weight: 0,
      demand,
      category: cat,
      qty: {},
      expected_cost: 0,
      expected_risk: 0,
      status: "Infeasible",
      notes: "no open suppliers",
    };
  }
  const [cost, risk] = costRisk(suppliers, qmap);
  return {
    label: "single_cheapest",
    risk_weight: 0,
    demand,
    category: cat,
    qty: qmap,
    expected_cost: cost,
    expected_risk: risk,
    status,
    notes: note,
  };
}

export function baselineEvenSplit(suppliers: Supplier[], demand: number): Allocation {
  const cat = suppliers[0]!.category;
  const openS = suppliers.filter((s) => s.open);
  if (!openS.length) {
    return {
      label: "even_split",
      risk_weight: 0,
      demand,
      category: cat,
      qty: {},
      expected_cost: 0,
      expected_risk: 0,
      status: "Infeasible",
      notes: "no open suppliers",
    };
  }
  const n = openS.length;
  const qmap: Record<number, number> = {};
  for (const s of openS) {
    let q = demand / n;
    if (q < s.moq) q = s.moq <= s.available ? s.moq : 0;
    q = Math.min(q, s.available);
    if (q > 1e-9) qmap[s.id] = q;
  }
  let total = Object.values(qmap).reduce((a, b) => a + b, 0);
  if (total > demand + 1e-6) {
    let extra = total - demand;
    const byId = new Map(openS.map((s) => [s.id, s]));
    const order = Object.keys(qmap)
      .map(Number)
      .sort((a, b) => qmap[b]! - qmap[a]!);
    for (const sid of order) {
      const s = byId.get(sid)!;
      const peelable = qmap[sid]! - s.moq;
      const take = Math.min(extra, Math.max(0, peelable));
      qmap[sid]! -= take;
      extra -= take;
      if (extra <= 1e-9) break;
    }
    for (const k of Object.keys(qmap)) {
      if (qmap[Number(k)]! <= 1e-6) delete qmap[Number(k)];
    }
    total = Object.values(qmap).reduce((a, b) => a + b, 0);
  }
  if (total + 1e-6 < demand) {
    let leftover = demand - total;
    const room = openS
      .map((s) => [s.id, s.available - (qmap[s.id] ?? 0)] as const)
      .filter(([, r]) => r > 1e-9);
    for (const [sid, r] of room) {
      if (leftover <= 1e-9) break;
      const add = Math.min(r, leftover);
      qmap[sid] = (qmap[sid] ?? 0) + add;
      leftover -= add;
    }
  }
  const [cost, risk] = costRisk(suppliers, qmap);
  return {
    label: "even_split",
    risk_weight: 0,
    demand,
    category: cat,
    qty: qmap,
    expected_cost: cost,
    expected_risk: risk,
    status: "Baseline",
    notes: "equal split across open suppliers",
  };
}

export function pctImpr(next: number, base: number): number | null {
  if (base <= 1e-12) return null;
  return ((base - next) / base) * 100;
}

export function baselineBlob(a: Allocation, suppliers: Supplier[]) {
  return {
    label: a.label,
    expected_cost: a.expected_cost,
    expected_risk: a.expected_risk,
    status: a.status,
    notes: a.notes,
    qty: qtyNamed(a, suppliers),
  };
}

export function qtyNamed(alloc: Allocation, suppliers: Supplier[]): Record<string, number> {
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const out: Record<string, number> = {};
  for (const [id, q] of Object.entries(alloc.qty)) {
    if (q > 1e-6) out[names.get(Number(id))!] = q;
  }
  return out;
}

export function optimizeCategory(
  suppliers: Supplier[],
  demand: number,
): {
  solved: Allocation[];
  category: string;
  single: Allocation;
  even: Allocation;
} {
  attachRisk(suppliers);
  const solved = SWEEP.map(([label, w]) => solveEnum(suppliers, demand, w, label));
  const single = baselineSingleCheapest(suppliers, demand);
  const even = baselineEvenSplit(suppliers, demand);
  return { solved, category: suppliers[0]!.category, single, even };
}

export function pickLabel(solved: Allocation[], label: string): Allocation {
  return solved.find((a) => a.label === label) ?? solved[0]!;
}
