import { LiveNumber } from '@/components/LiveNumber'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import type { Strategy } from '@/hooks/useDashboardData'
import { payloadOf } from '@/hooks/useDashboardData'
import { formatInr } from '@/lib/format'

export function RecommendedAllocation({
  strategy,
  liveTick,
}: {
  strategy: Strategy | null
  liveTick: number
}) {
  const p = strategy ? payloadOf(strategy) : null
  const lines = (p?.suppliers ?? []).filter((s) => s.qty > 0)
  const closed = p?.closed_suppliers ?? []

  return (
    <Card key={liveTick} className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <div>
          <CardTitle>Recommended allocation</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Current best strategy for this category ({p?.label ?? '—'}). Numbers come from the
            solver row, not the explainer.
          </p>
        </div>
      </CardHeader>
      <CardBody>
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-background/50 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Expected cost
            </div>
            <div className="text-2xl font-semibold text-foreground">
              <LiveNumber value={strategy?.expected_cost} kind="inr" />
            </div>
          </div>
          <div className="rounded-md border border-border bg-background/50 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Expected risk
            </div>
            <div className="text-2xl font-semibold text-primary">
              <LiveNumber value={strategy?.expected_risk} kind="risk" />
            </div>
          </div>
        </div>
        <ul className="space-y-2">
          {lines.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span>
                {s.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {s.qty.toFixed(0)} units
                </span>
              </span>
              <span className="tabular text-xs text-muted-foreground">
                {s.predicted_price != null ? formatInr(s.qty * s.predicted_price, true) : ''}
              </span>
            </li>
          ))}
          {lines.length === 0 && (
            <li className="text-sm text-muted-foreground">No open allocation for this category.</li>
          )}
        </ul>
        {closed.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Closed (available &lt; MOQ): {closed.map((c) => c.name).join(', ')}
          </p>
        )}
        {p?.objective && (
          <details className="mt-3 rounded-md border border-border/80 bg-background/30 p-2 text-xs">
            <summary className="cursor-pointer font-medium text-primary">How was this computed?</summary>
            <p className="mt-2 font-mono leading-relaxed text-muted-foreground">{p.objective}</p>
            {p.solver && (
              <p className="mt-1 text-muted-foreground">
                Solver: {p.solver}
                {p.status ? ` · ${p.status}` : ''}
                {p.demand != null ? ` · demand ${p.demand}` : ''}
              </p>
            )}
          </details>
        )}
      </CardBody>
    </Card>
  )
}
