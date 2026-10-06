import type { Json } from '@/lib/database.types'

export const CATEGORIES = [
  'contract_manufacturing',
  'raw_herbs',
  'packaging',
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABEL: Record<string, string> = {
  contract_manufacturing: 'Contract manufacturing',
  raw_herbs: 'Raw herbs',
  packaging: 'Packaging',
}

export const STRATEGY_LABELS = ['cost_aggressive', 'balanced', 'risk_averse'] as const
export type StrategyLabel = (typeof STRATEGY_LABELS)[number]
export const SWEEP_WEIGHT: Record<StrategyLabel, number> = {
  cost_aggressive: 0,
  balanced: 0.7,
  risk_averse: 4,
}

export type QtyMap = Record<string, number>

export type AllocSupplier = {
  id: number
  name: string
  qty: number
  predicted_price?: number
  unit_risk?: number
  available?: number
  moq?: number
}

export type BaselineBlob = {
  label: string
  expected_cost: number
  expected_risk: number
  status?: string
  notes?: string
  qty?: QtyMap
}

export type ShockBlob = {
  label?: string
  qty?: QtyMap
  expected_cost?: number
  expected_risk?: number
  status?: string
  util?: number
  available?: number
  open?: boolean
}

export type AllocationPayload = {
  run_id?: string
  label?: string
  category?: string
  demand?: number
  risk_weight?: number
  solver?: string
  status?: string
  objective?: string
  expected_cost?: number
  expected_risk?: number
  suppliers?: AllocSupplier[]
  closed_suppliers?: { id: number; name: string; reason?: string; available?: number; moq?: number }[]
  baselines?: {
    single_cheapest?: BaselineBlob
    even_split?: BaselineBlob
  }
  improvement_pct?: {
    cost_vs_single?: number | null
    risk_vs_single?: number | null
    cost_vs_even?: number | null
    risk_vs_even?: number | null
  }
  disruption?: {
    supplier_id?: number
    type?: string
    magnitude?: number
    run_id?: string
  }
  before?: ShockBlob
  after?: ShockBlob
}

export type UncertaintyBlock = { std?: number; mae?: number }

export function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function asRecord(v: Json | undefined | null): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return {}
}

export function parseAllocation(json: Json): AllocationPayload {
  return asRecord(json) as AllocationPayload
}

export function stdFromUncertainty(unc: Json, key: string): number {
  const rec = asRecord(unc)
  const block = rec[key]
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    const std = (block as UncertaintyBlock).std
    return typeof std === 'number' ? std : Number(std ?? 0)
  }
  return 0
}

export function compositeStd(unc: Json): number {
  const d = stdFromUncertainty(unc, 'defect_rate')
  const l = stdFromUncertainty(unc, 'lead_time')
  return Math.hypot(d, l / 10)
}

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v)
}
