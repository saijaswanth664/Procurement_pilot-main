import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/lib/database.types'
import {
  parseAllocation,
  type AllocationPayload,
  type Category,
} from '@/lib/allocation'

export type Supplier = Tables<'suppliers'>
export type Forecast = Tables<'supplier_forecasts'>
export type Strategy = Tables<'strategies'>
export type Decision = Tables<'decisions'>
export type Disruption = Tables<'disruptions'>
export type Batch = Tables<'batches'>
export type Order = Tables<'orders'>
export type Message = Tables<'messages'>

export type LatestForecast = Forecast & { supplier: Supplier }

export type DashboardData = {
  suppliers: Supplier[]
  forecasts: LatestForecast[]
  strategies: Strategy[]
  decisions: Decision[]
  disruptions: Disruption[]
  batches: Batch[]
  orders: Order[]
  messages: Message[]
  liveTick: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function coerceForecast(row: Forecast): Forecast {
  return {
    ...row,
    predicted_capacity_util: num(row.predicted_capacity_util),
    predicted_defect_rate: num(row.predicted_defect_rate),
    predicted_lead_time: num(row.predicted_lead_time),
    predicted_price: num(row.predicted_price),
    predicted_reliability: num(row.predicted_reliability),
  }
}

function coerceStrategy(row: Strategy): Strategy {
  return {
    ...row,
    expected_cost: row.expected_cost == null ? null : num(row.expected_cost),
    expected_risk: row.expected_risk == null ? null : num(row.expected_risk),
    risk_weight: num(row.risk_weight),
  }
}

function latestForecasts(rows: Forecast[], suppliers: Supplier[]): LatestForecast[] {
  const byId = new Map(suppliers.map((s) => [s.id, s]))
  const seen = new Set<number>()
  const out: LatestForecast[] = []
  for (const f of rows) {
    if (seen.has(f.supplier_id)) continue
    seen.add(f.supplier_id)
    const supplier = byId.get(f.supplier_id)
    if (!supplier) continue
    out.push({ ...f, supplier })
  }
  return out
}

export function useDashboardData(): DashboardData {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [forecastRows, setForecastRows] = useState<Forecast[]>([])
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [disruptions, setDisruptions] = useState<Disruption[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [liveTick, setLiveTick] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [s, f, st, d, di, b, o, m] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('supplier_forecasts').select('*').order('generated_at', { ascending: false }),
      supabase.from('strategies').select('*').order('created_at', { ascending: false }),
      supabase.from('decisions').select('*').order('created_at', { ascending: false }).limit(80),
      supabase.from('disruptions').select('*').order('triggered_at', { ascending: false }),
      supabase.from('batches').select('*').order('created_at', { ascending: false }),
      supabase.from('orders').select('*').order('created_at', { ascending: false }),
      supabase.from('messages').select('*').order('created_at', { ascending: true }),
    ])
    const firstErr = s.error ?? f.error ?? st.error ?? d.error ?? di.error ?? b.error ?? o.error ?? m.error
    if (firstErr) {
      setError(firstErr.message)
      return
    }
    setError(null)
    setSuppliers(s.data ?? [])
    setForecastRows((f.data ?? []).map(coerceForecast))
    setStrategies((st.data ?? []).map(coerceStrategy))
    setDecisions(d.data ?? [])
    setDisruptions(di.data ?? [])
    setBatches(b.data ?? [])
    setOrders(o.data ?? [])
    setMessages(m.data ?? [])
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void reload().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const bump = () => {
      setLiveTick((n) => n + 1)
      void reload()
    }
    const channel = supabase
      .channel('ops-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategies' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'decisions' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'disruptions' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplier_forecasts' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'batches' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, bump)
      .subscribe()
    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [reload])

  const forecasts = useMemo(
    () => latestForecasts(forecastRows, suppliers),
    [forecastRows, suppliers],
  )

  return {
    suppliers,
    forecasts,
    strategies,
    decisions,
    disruptions,
    batches,
    orders,
    messages,
    liveTick,
    loading,
    error,
    reload,
  }
}

export function payloadOf(row: Strategy): AllocationPayload {
  return parseAllocation(row.allocation_json)
}

export function categoryOf(row: Strategy): string {
  return payloadOf(row).category ?? ''
}

export function latestRunForCategory(strategies: Strategy[], category: Category): string | null {
  const hit = strategies.find((s) => categoryOf(s) === category)
  return hit?.run_id ?? null
}

export function strategiesInRun(strategies: Strategy[], runId: string, category: Category): Strategy[] {
  return strategies.filter((s) => s.run_id === runId && categoryOf(s) === category)
}

export function pickSweepRow(rows: Strategy[], label: string, weight: number): Strategy | null {
  const byWeight = rows.filter((s) => Math.abs(s.risk_weight - weight) < 1e-6)
  if (byWeight.length === 1) return byWeight[0] ?? null
  const byLabel = rows.filter((s) => payloadOf(s).label === label)
  if (byLabel.length === 1) return byLabel[0] ?? null
  return byWeight[0] ?? byLabel[0] ?? null
}
