import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BatchesPanel } from '@/components/panels/BatchesPanel'
import { DecisionLog } from '@/components/panels/DecisionLog'
import { RecommendedAllocation } from '@/components/panels/RecommendedAllocation'
import { RiskMatrix } from '@/components/panels/RiskMatrix'
import { ScenarioComparison } from '@/components/panels/ScenarioComparison'
import { StrategyHistory } from '@/components/panels/StrategyHistory'
import { TriggerDisruption } from '@/components/panels/TriggerDisruption'
import { ChatPanel } from '@/components/panels/ChatPanel'
import { EscalatedMessages } from '@/components/panels/EscalatedMessages'
import {
  categoryOf,
  latestRunForCategory,
  payloadOf,
  strategiesInRun,
  useDashboardData,
} from '@/hooks/useDashboardData'
import { CATEGORIES, CATEGORY_LABEL, type Category } from '@/lib/allocation'

const SECTIONS = [
  { id: 'matrix', label: 'Risk matrix' },
  { id: 'alloc', label: 'Allocation' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'history', label: 'History' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'qc', label: 'QC batches' },
  { id: 'chat', label: 'Chat' },
] as const

export function Dashboard() {
  const { profile, user, signOut } = useAuth()
  const data = useDashboardData()
  const isOwner = profile?.role === 'business_owner'
  const [category, setCategory] = useState<Category>('contract_manufacturing')
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('matrix')

  const runId = useMemo(
    () => latestRunForCategory(data.strategies, category),
    [data.strategies, category],
  )
  const runRows = useMemo(
    () => (runId ? strategiesInRun(data.strategies, runId, category) : []),
    [data.strategies, runId, category],
  )
  const recommended = useMemo(() => {
    const bal = runRows.find((r) => payloadOf(r).label === 'balanced')
    const ag = runRows.find((r) => payloadOf(r).label === 'cost_aggressive')
    return bal ?? ag ?? runRows[0] ?? null
  }, [runRows])

  const forecasts = data.forecasts.filter((f) => f.supplier.category === category)

  function go(id: (typeof SECTIONS)[number]['id']) {
    setSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-primary">AyuraNest ops</p>
            <h1 className="text-lg font-semibold leading-none tracking-tight">ProcurementPilot</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="hidden sm:inline">
              {profile?.display_name ?? user?.email} · {profile?.role ?? 'no profile'}
            </span>
            {data.liveTick > 0 && (
              <span className="rounded-full border border-primary/40 px-2 py-0.5 text-primary">
                live ×{data.liveTick}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 pb-3">
          <Tabs value={category} onValueChange={(v) => setCategory(v as Category)}>
            <TabsList>
              {CATEGORIES.map((c) => (
                <TabsTrigger key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Tabs value={section} onValueChange={(v) => go(v as (typeof SECTIONS)[number]['id'])}>
            <TabsList>
              {SECTIONS.map((s) => (
                <TabsTrigger key={s.id} value={s.id}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {isOwner && (
            <div className="ml-auto">
              <TriggerDisruption suppliers={data.suppliers} />
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-4">
        {data.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {data.error}
          </p>
        )}
        {data.loading && <p className="text-sm text-muted-foreground">Loading live tables…</p>}
        {!isOwner && (
          <p className="text-sm text-muted-foreground">
            Supplier role: RLS limits you to your own supplier rows. Allocation, scenarios, and the
            decision log are owner-only.
          </p>
        )}

        <div id="matrix" className="grid gap-4 lg:grid-cols-2">
          <RiskMatrix forecasts={forecasts} liveTick={data.liveTick} category={category} />
          <div id="alloc">
            <RecommendedAllocation strategy={recommended} liveTick={data.liveTick} />
          </div>
        </div>

        <div id="scenarios">
          <ScenarioComparison rows={runRows} forecasts={forecasts} liveTick={data.liveTick} />
        </div>

        <div id="history" className="grid gap-4 lg:grid-cols-2">
          <StrategyHistory
            strategies={data.strategies.filter((s) => categoryOf(s) === category)}
            disruptions={data.disruptions}
            liveTick={data.liveTick}
          />
          <div id="decisions">
            <DecisionLog decisions={data.decisions} liveTick={data.liveTick} />
          </div>
        </div>

        <div id="qc">
          <BatchesPanel
            batches={data.batches}
            orders={data.orders}
            suppliers={data.suppliers}
            liveTick={data.liveTick}
          />
        </div>

        <div id="chat" className="grid gap-4 lg:grid-cols-2">
          <ChatPanel
            messages={data.messages}
            suppliers={data.suppliers}
            liveTick={data.liveTick}
          />
          {isOwner && (
            <EscalatedMessages
              messages={data.messages}
              suppliers={data.suppliers}
              liveTick={data.liveTick}
            />
          )}
        </div>
      </main>
    </div>
  )
}
