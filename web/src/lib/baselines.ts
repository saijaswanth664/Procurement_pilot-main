/** Same baseline rules as scripts/optimize_allocation.py (not a second optimizer). */

export const LATE_ANCHOR = 0.5
export const QUAL_ANCHOR = 0.02
export const CAP_ANCHOR = 2.0
export const W_LATE = 0.4
export const W_QUAL = 0.4
export const W_CAP = 0.2

export type BaselineSupplier = {
  id: number
  name: string
  moq: number
  max_capacity: number
  predicted_price: number
  predicted_lead_time: number
  predicted_defect_rate: number
  predicted_capacity_util: number
  lead_std: number
  defect_std: number
  available: number
  unit_risk: number
  open: boolean
}

export type BaselineResult = {
  label: string
  expected_cost: number
  expected_risk: number
  status: string
  notes: string
  qty: Record<string, number>
}

function forecastAvailable(maxCapacity: number, util: number): number {
  const u = Math.min(Math.max(util, 0), 0.999)
  return Math.max(0, maxCapacity * (1 - u))
}

export function attachRisk(suppliers: BaselineSupplier[]): void {
  for (const s of suppliers) {
    const capStress =
      s.predicted_capacity_util / Math.max(1e-3, 1 - Math.min(s.predicted_capacity_util, 0.999))
    s.unit_risk =
      W_LATE * (s.lead_std / LATE_ANCHOR) +
      W_QUAL * ((s.predicted_defect_rate + s.defect_std) / QUAL_ANCHOR) +
      W_CAP * (capStress / CAP_ANCHOR)
    s.available = forecastAvailable(s.max_capacity, s.predicted_capacity_util)
    s.open = s.available + 1e-9 >= s.moq
  }
}

function costRisk(suppliers: BaselineSupplier[], qty: Record<number, number>): [number, number] {
  const byId = new Map(suppliers.map((s) => [s.id, s]))
  let totalQ = 0
  let cost = 0
  let riskNum = 0
  for (const [idStr, q] of Object.entries(qty)) {
    const s = byId.get(Number(idStr))
    if (!s) continue
    totalQ += q
    cost += s.predicted_price * q
    riskNum += s.unit_risk * q
  }
  return [cost, totalQ <= 1e-9 ? 0 : riskNum / totalQ]
}

function namedQty(suppliers: BaselineSupplier[], qty: Record<number, number>): Record<string, number> {
  const names = new Map(suppliers.map((s) => [s.id, s.name]))
  const out: Record<string, number> = {}
  for (const [id, q] of Object.entries(qty)) {
    if (q > 1e-6) out[names.get(Number(id)) ?? id] = q
  }
  return out
}

export function baselineSingleCheapest(
  suppliers: BaselineSupplier[],
  demand: number,
): BaselineResult {
  const openS = suppliers.filter((s) => s.open)
  const fillers = openS.filter((s) => s.available + 1e-9 >= demand && demand + 1e-9 >= s.moq)
  let qmap: Record<number, number> = {}
  let notes: string
  let status: string
  if (fillers.length) {
    const pick = fillers.reduce((a, b) => (a.predicted_price < b.predicted_price ? a : b))
    qmap = { [pick.id]: demand }
    notes = `single supplier ${pick.name} (cheapest who can fill ${demand})`
    status = 'Baseline'
  } else if (openS.length) {
    const pick = openS.reduce((a, b) => (a.predicted_price < b.predicted_price ? a : b))
    const q = Math.min(demand, pick.available)
    qmap = q + 1e-9 >= pick.moq ? { [pick.id]: q } : {}
    notes = `single supplier ${pick.name} cannot fill ${demand}; allocated ${q.toFixed(1)}`
    status = 'Baseline-shortfall'
  } else {
    return {
      label: 'single_cheapest',
      expected_cost: 0,
      expected_risk: 0,
      status: 'Infeasible',
      notes: 'no open suppliers',
      qty: {},
    }
  }
  const [cost, risk] = costRisk(suppliers, qmap)
  return {
    label: 'single_cheapest',
    expected_cost: cost,
    expected_risk: risk,
    status,
    notes,
    qty: namedQty(suppliers, qmap),
  }
}

export function baselineEvenSplit(suppliers: BaselineSupplier[], demand: number): BaselineResult {
  const openS = suppliers.filter((s) => s.open)
  if (!openS.length) {
    return {
      label: 'even_split',
      expected_cost: 0,
      expected_risk: 0,
      status: 'Infeasible',
      notes: 'no open suppliers',
      qty: {},
    }
  }
  const n = openS.length
  const qmap: Record<number, number> = {}
  for (const s of openS) {
    let q = demand / n
    if (q < s.moq) q = s.moq <= s.available ? s.moq : 0
    q = Math.min(q, s.available)
    if (q > 1e-9) qmap[s.id] = q
  }
  let total = Object.values(qmap).reduce((a, b) => a + b, 0)
  if (total > demand + 1e-6) {
    let extra = total - demand
    const byId = new Map(openS.map((s) => [s.id, s]))
    const order = Object.keys(qmap)
      .map(Number)
      .sort((a, b) => qmap[b]! - qmap[a]!)
    for (const sid of order) {
      const s = byId.get(sid)!
      const peelable = qmap[sid]! - s.moq
      const take = Math.min(extra, Math.max(0, peelable))
      qmap[sid]! -= take
      extra -= take
      if (extra <= 1e-9) break
    }
    for (const k of Object.keys(qmap)) {
      if (qmap[Number(k)]! <= 1e-6) delete qmap[Number(k)]
    }
    total = Object.values(qmap).reduce((a, b) => a + b, 0)
  }
  if (total + 1e-6 < demand) {
    let leftover = demand - total
    const room = openS
      .map((s) => [s.id, s.available - (qmap[s.id] ?? 0)] as const)
      .filter(([, r]) => r > 1e-9)
    for (const [sid, r] of room) {
      if (leftover <= 1e-9) break
      const add = Math.min(r, leftover)
      qmap[sid] = (qmap[sid] ?? 0) + add
      leftover -= add
    }
  }
  const [cost, risk] = costRisk(suppliers, qmap)
  return {
    label: 'even_split',
    expected_cost: cost,
    expected_risk: risk,
    status: 'Baseline',
    notes: 'equal split across open suppliers',
    qty: namedQty(suppliers, qmap),
  }
}

export function pctImpr(next: number, base: number): number | null {
  if (base <= 1e-12) return null
  return ((base - next) / base) * 100
}
