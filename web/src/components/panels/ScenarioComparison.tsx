import { useEffect, useMemo } from 'react'
import { LiveNumber } from '@/components/LiveNumber'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import type { LatestForecast, Strategy } from '@/hooks/useDashboardData'
import { payloadOf, pickSweepRow } from '@/hooks/useDashboardData'
import {
  STRATEGY_LABELS,
  SWEEP_WEIGHT,
  asFiniteNumber,
  stdFromUncertainty,
  type BaselineBlob,
} from '@/lib/allocation'
import {
  attachRisk,
  baselineEvenSplit,
  baselineSingleCheapest,
  pctImpr,
  type BaselineSupplier,
} from '@/lib/baselines'
import { formatPct } from '@/lib/format'
import { cn } from '@/lib/utils'

function pctClass(n: number | null | undefined) {
  if (n == null) return 'text-muted-foreground'
  return n >= 0 ? 'text-emerald-400' : 'text-destructive'
}

function qtyLine(qty: Record<string, number> | undefined): string {
  if (!qty) return ''
  return Object.entries(qty)
    .filter(([, v]) => Number(v) > 1e-6)
    .map(([k, v]) => `${k}: ${Number(v).toFixed(0)}`)
    .join(' · ')
}

function suppliersToQty(row: Strategy | null): Record<string, number> | undefined {
  if (!row) return undefined
  const p = payloadOf(row)
  if (!p.suppliers?.length) return undefined
  const out: Record<string, number> = {}
  for (const s of p.suppliers) {
    if (s.qty > 1e-6) out[s.name] = s.qty
  }
  return out
}

function blobCost(b: BaselineBlob | undefined): number | null {
  return asFiniteNumber(b?.expected_cost)
}

function blobRisk(b: BaselineBlob | undefined): number | null {
  return asFiniteNumber(b?.expected_risk)
}

function forecastsToPool(forecasts: LatestForecast[]): BaselineSupplier[] {
  return forecasts.map((f) => ({
    id: f.supplier.id,
    name: f.supplier.name,
    moq: Number(f.supplier.moq),
    max_capacity: Number(f.supplier.max_capacity),
    predicted_price: f.predicted_price,
    predicted_lead_time: f.predicted_lead_time,
    predicted_defect_rate: f.predicted_defect_rate,
    predicted_capacity_util: f.predicted_capacity_util,
    lead_std: stdFromUncertainty(f.uncertainty, 'lead_time'),
    defect_std: stdFromUncertainty(f.uncertainty, 'defect_rate'),
    available: 0,
    unit_risk: 0,
    open: true,
  }))
}

export function ScenarioComparison({
  rows,
  forecasts,
  liveTick,
}: {
  rows: Strategy[]
  forecasts: LatestForecast[]
  liveTick: number
}) {
  const sweep = STRATEGY_LABELS.map((label) => {
    const row = pickSweepRow(rows, label, SWEEP_WEIGHT[label])
    return {
      key: label,
      title: label.replace('_', ' '),
      row,
      cost: row ? asFiniteNumber(row.expected_cost) : null,
      risk: row ? asFiniteNumber(row.expected_risk) : null,
      qty: suppliersToQty(row),
      highlight: label === 'balanced',
    }
  })

  const balanced = sweep.find((s) => s.key === 'balanced')?.row ?? rows[0] ?? null
  const p = balanced ? payloadOf(balanced) : null
  const storedCheap = p?.baselines?.single_cheapest
  const storedEven = p?.baselines?.even_split
  const demand = asFiniteNumber(p?.demand) ?? 0

  const computed = useMemo(() => {
    const storedOk = blobCost(storedCheap) != null && blobCost(storedEven) != null
    if (storedOk || !forecasts.length || demand <= 0) return null
    const pool = forecastsToPool(forecasts)
    attachRisk(pool)
    return {
      single: baselineSingleCheapest(pool, demand),
      even: baselineEvenSplit(pool, demand),
      source: 'computed from latest forecasts (baselines missing on this run)',
    }
  }, [storedCheap, storedEven, forecasts, demand])

  const cheap: BaselineBlob | undefined = storedCheap ??
    (computed
      ? {
          label: computed.single.label,
          expected_cost: computed.single.expected_cost,
          expected_risk: computed.single.expected_risk,
          status: computed.single.status,
          notes: computed.single.notes,
          qty: computed.single.qty,
        }
      : undefined)
  const even: BaselineBlob | undefined = storedEven ??
    (computed
      ? {
          label: computed.even.label,
          expected_cost: computed.even.expected_cost,
          expected_risk: computed.even.expected_risk,
          status: computed.even.status,
          notes: computed.even.notes,
          qty: computed.even.qty,
        }
      : undefined)

  const cheapCost = blobCost(cheap)
  const evenCost = blobCost(even)
  const cheapRisk = blobRisk(cheap)
  const evenRisk = blobRisk(even)
  const balCost = sweep.find((s) => s.key === 'balanced')?.cost ?? null
  const balRisk = sweep.find((s) => s.key === 'balanced')?.risk ?? null

  const impr = p?.improvement_pct ??
    (balCost != null && cheapCost != null && evenCost != null
      ? {
          cost_vs_single: pctImpr(balCost, cheapCost),
          risk_vs_single: balRisk != null && cheapRisk != null ? pctImpr(balRisk, cheapRisk) : null,
          cost_vs_even: pctImpr(balCost, evenCost),
          risk_vs_even: balRisk != null && evenRisk != null ? pctImpr(balRisk, evenRisk) : null,
        }
      : null)

  const qtySets = sweep.map((s) => JSON.stringify(s.qty ?? {}))
  const converged = qtySets.length === 3 && qtySets.every((q) => q === qtySets[0])

  const cells = [
    ...sweep.map((c) => ({
      key: c.key,
      title: c.title,
      cost: c.cost,
      risk: c.risk,
      qty: c.qty,
      highlight: c.highlight,
      id: c.row?.id,
      weight: c.row?.risk_weight,
    })),
    {
      key: 'single',
      title: 'cheapest-only',
      cost: cheapCost,
      risk: cheapRisk,
      qty: cheap?.qty,
      highlight: false,
      id: undefined as number | undefined,
      weight: undefined as number | undefined,
    },
    {
      key: 'even',
      title: 'even-split',
      cost: evenCost,
      risk: evenRisk,
      qty: even?.qty,
      highlight: false,
      id: undefined as number | undefined,
      weight: undefined as number | undefined,
    },
  ]

  const before = p?.before
  const after = p?.after

  useEffect(() => {
    const dump = rows.map((r) => {
      const payload = payloadOf(r)
      return {
        id: r.id,
        run_id: r.run_id,
        risk_weight: r.risk_weight,
        expected_cost: r.expected_cost,
        expected_risk: r.expected_risk,
        label: payload.label,
        category: payload.category,
        solver: payload.solver,
        suppliers: payload.suppliers,
        baselines: payload.baselines,
        improvement_pct: payload.improvement_pct,
      }
    })
    console.log('[scenario-comparison] raw strategies for this run_id + category', dump)
  }, [rows])

  return (
    <Card key={liveTick} className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <div>
          <CardTitle>Scenario comparison</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Each λ card is the strategies row with that risk_weight (0 / 0.7 / 4). Baselines are
            allocation_json.baselines, or recomputed with the Python even-split / cheapest-only
            rules when a disruption write omitted them.
          </p>
        </div>
      </CardHeader>
      <CardBody>
        {converged && (
          <p className="mb-3 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            λ sweep converged on the same fill — not a UI duplicate. {qtyLine(sweep[0]?.qty)}
          </p>
        )}
        {computed && (
          <p className="mb-3 text-[11px] text-primary">{computed.source}</p>
        )}
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {cells.map((c) => (
            <div
              key={c.key}
              className={cn(
                'rounded-md border px-2.5 py-2',
                c.highlight ? 'border-primary/70 bg-primary/10' : 'border-border bg-background/40',
              )}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {c.title}
                {c.id != null && (
                  <span className="ml-1 font-mono normal-case text-[9px]">#{c.id} λ={c.weight}</span>
                )}
              </div>
              <div className="mt-1 text-sm font-semibold">
                <LiveNumber value={c.cost} kind="inr" />
              </div>
              <div className="text-xs text-muted-foreground">
                risk <LiveNumber value={c.risk} kind="risk" />
              </div>
              {c.qty && (
                <p className="mt-1 font-mono text-[10px] leading-snug text-muted-foreground">
                  {qtyLine(c.qty)}
                </p>
              )}
            </div>
          ))}
        </div>
        {impr && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className={cn('rounded border border-border px-2 py-1', pctClass(impr.cost_vs_even))}>
              balanced vs even-split cost {formatPct(impr.cost_vs_even)}
            </span>
            <span className={cn('rounded border border-border px-2 py-1', pctClass(impr.risk_vs_even))}>
              risk {formatPct(impr.risk_vs_even)}
            </span>
            <span className={cn('rounded border border-border px-2 py-1', pctClass(impr.cost_vs_single))}>
              vs cheapest-only cost {formatPct(impr.cost_vs_single)}
            </span>
            <span className={cn('rounded border border-border px-2 py-1', pctClass(impr.risk_vs_single))}>
              risk {formatPct(impr.risk_vs_single)}
            </span>
          </div>
        )}
        {before && after && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-background/30 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Before shock
              </div>
              <div className="text-lg font-semibold">
                <LiveNumber value={asFiniteNumber(before.expected_cost)} kind="inr" />
              </div>
              <div className="text-xs text-muted-foreground">
                risk <LiveNumber value={asFiniteNumber(before.expected_risk)} kind="risk" />
              </div>
              {before.qty && (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{qtyLine(before.qty)}</p>
              )}
            </div>
            <div className="rounded-md border border-primary/50 bg-primary/10 p-3">
              <div className="text-[10px] uppercase tracking-wider text-primary">After re-plan</div>
              <div className="text-lg font-semibold">
                <LiveNumber value={asFiniteNumber(after.expected_cost)} kind="inr" />
              </div>
              <div className="text-xs text-muted-foreground">
                risk <LiveNumber value={asFiniteNumber(after.expected_risk)} kind="risk" />
              </div>
              {after.qty && (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{qtyLine(after.qty)}</p>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
