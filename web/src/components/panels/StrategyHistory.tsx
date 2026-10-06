import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import type { Disruption, Strategy } from '@/hooks/useDashboardData'
import { payloadOf } from '@/hooks/useDashboardData'
import { formatInr, formatRisk, formatWhen, shortId } from '@/lib/format'

type Group = {
  runId: string
  createdAt: string
  rows: Strategy[]
  disruption: Disruption | null
}

export function StrategyHistory({
  strategies,
  disruptions,
  liveTick,
}: {
  strategies: Strategy[]
  disruptions: Disruption[]
  liveTick: number
}) {
  const byRun = new Map<string, Strategy[]>()
  for (const s of strategies) {
    const list = byRun.get(s.run_id) ?? []
    list.push(s)
    byRun.set(s.run_id, list)
  }
  const disByRun = new Map(
    disruptions.filter((d) => d.run_id).map((d) => [d.run_id as string, d]),
  )
  const groups: Group[] = [...byRun.entries()]
    .map(([runId, rows]) => ({
      runId,
      createdAt: rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), rows[0].created_at),
      rows: rows.sort((a, b) => a.risk_weight - b.risk_weight),
      disruption: disByRun.get(runId) ?? null,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  return (
    <Card key={liveTick} className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <div>
          <CardTitle>Agent strategy history</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Grouped by run_id. A disruption re-plan sits in its own run and carries before/after
            blobs on the allocation payload.
          </p>
        </div>
      </CardHeader>
      <CardBody className="max-h-[420px] space-y-3 overflow-y-auto">
        {groups.map((g) => {
          const first = g.rows[0]
          if (!first) return null
          const sample = payloadOf(first)
          const cat = sample.category ?? '—'
          return (
            <div key={g.runId} className="rounded-md border border-border bg-background/30 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs">
                  <span className="font-mono text-primary">{shortId(g.runId)}</span>
                  <span className="mx-2 text-muted-foreground">{cat}</span>
                  <span className="text-muted-foreground">{formatWhen(g.createdAt)}</span>
                </div>
                {g.disruption && (
                  <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                    {g.disruption.type} {g.disruption.magnitude}%
                  </span>
                )}
              </div>
              {sample.before && sample.after && (
                <div className="mb-2 grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded border border-border/80 p-2">
                    <div className="text-muted-foreground">Before</div>
                    <div>
                      {formatInr(sample.before.expected_cost, true)} · risk{' '}
                      {formatRisk(sample.before.expected_risk ?? null)}
                    </div>
                  </div>
                  <div className="rounded border border-primary/40 p-2">
                    <div className="text-primary">After</div>
                    <div>
                      {formatInr(sample.after.expected_cost, true)} · risk{' '}
                      {formatRisk(sample.after.expected_risk ?? null)}
                    </div>
                  </div>
                </div>
              )}
              <ul className="space-y-1 text-xs">
                {g.rows.map((r) => {
                  const lab = payloadOf(r).label ?? `λ=${r.risk_weight}`
                  return (
                    <li key={r.id} className="flex justify-between gap-2 font-mono">
                      <span className="text-muted-foreground">{lab}</span>
                      <span>
                        {formatInr(r.expected_cost, true)} · {formatRisk(r.expected_risk)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}
