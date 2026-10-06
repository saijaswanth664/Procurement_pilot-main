import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import type { Decision } from '@/hooks/useDashboardData'
import { formatWhen } from '@/lib/format'

export function DecisionLog({ decisions, liveTick }: { decisions: Decision[]; liveTick: number }) {
  return (
    <Card
      key={liveTick}
      className="border-[color:var(--proof-border)] bg-[color:var(--proof)]/80"
      style={liveTick ? undefined : undefined}
    >
      <CardHeader>
        <div>
          <CardTitle className="text-primary">Decision log</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing was decided silently. Verbatim decision_text and reasoning — including numeric
            cost/risk deltas from the re-plan agent.
          </p>
        </div>
        <span className="rounded-full border border-primary/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
          proof
        </span>
      </CardHeader>
      <CardBody className="max-h-[420px] space-y-3 overflow-y-auto">
        {decisions.map((d) => (
          <article
            key={d.id}
            className="rounded-md border border-primary/25 bg-background/40 p-3"
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>
                {d.made_by} · {d.related_entity_type} #{d.related_entity_id}
              </span>
              <span>{formatWhen(d.created_at)}</span>
            </div>
            <p className="text-sm font-medium leading-snug text-foreground">{d.decision_text}</p>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {d.reasoning}
            </p>
          </article>
        ))}
      </CardBody>
    </Card>
  )
}
