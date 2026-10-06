import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { formatWhen } from '@/lib/format'
import type { Message, Supplier } from '@/hooks/useDashboardData'

export function EscalatedMessages({
  messages,
  suppliers,
  liveTick,
}: {
  messages: Message[]
  suppliers: Supplier[]
  liveTick: number
}) {
  const escalated = messages.filter((m) => m.flagged_for_dashboard)

  if (escalated.length === 0) {
    return null
  }

  const names = new Map(suppliers.map((s) => [s.id, s.name]))

  return (
    <Card className={`border-destructive/50 ${liveTick ? 'flash-live' : ''}`}>
      <CardHeader className="bg-destructive/10 pb-4">
        <CardTitle className="text-destructive flex items-center gap-2">
          <span className="text-xl leading-none">🚨</span> Urgent Escalations
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 bg-destructive/5 pt-4">
        {escalated.map((msg) => {
          // Find supplier name via the UUID matching in the hackathon deterministic ID
          // Or just show "Supplier" if not found
          const threadSupplierId = msg.thread_id.split('-').pop()
          const supplierId = threadSupplierId ? Number(threadSupplierId) : null
          const supplierName = supplierId ? names.get(supplierId) : 'Supplier'

          return (
            <div key={msg.id} className="rounded-md border border-destructive/20 bg-background p-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-destructive uppercase tracking-wide">
                  {supplierName}
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">
                  {formatWhen(msg.created_at)}
                </span>
              </div>
              <p className="text-sm text-foreground mb-2">"{msg.body}"</p>
              <div className="text-[11px] text-muted-foreground mt-2 pt-2 border-t border-border">
                Classified by agent · See Decision Log for reasoning
              </div>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}
