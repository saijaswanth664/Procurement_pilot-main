import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { compositeStd, stdFromUncertainty } from '@/lib/allocation'
import type { LatestForecast } from '@/hooks/useDashboardData'
import { cn } from '@/lib/utils'

export function RiskMatrix({
  forecasts,
  liveTick,
  category,
}: {
  forecasts: LatestForecast[]
  liveTick: number
  category: string
}) {
  const rows = forecasts.filter((f) => !category || f.supplier.category === category)
  const xs = rows.map((r) => r.predicted_lead_time)
  const ys = rows.map((r) => r.predicted_defect_rate)
  const minX = Math.min(...xs, 0)
  const maxX = Math.max(...xs, 1)
  const minY = Math.min(...ys, 0)
  const maxY = Math.max(...ys, 0.01)
  const padX = (maxX - minX) * 0.12 || 1
  const padY = (maxY - minY) * 0.18 || 0.002
  const x0 = minX - padX
  const x1 = maxX + padX
  const y0 = minY - padY
  const y1 = maxY + padY
  const stds = rows.map((r) => compositeStd(r.uncertainty))
  const maxStd = Math.max(...stds, 0.001)

  const toX = (v: number) => ((v - x0) / (x1 - x0)) * 100
  const toY = (v: number) => (1 - (v - y0) / (y1 - y0)) * 100

  return (
    <Card key={liveTick} className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <div>
          <CardTitle>Supplier risk matrix</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Defect rate vs lead time. Dot size and heat = forecast uncertainty (std). Deccan Gold’s
            band should read wide.
          </p>
        </div>
      </CardHeader>
      <CardBody>
        <div className="relative h-[280px] rounded-md border border-border bg-background/40">
          <div className="absolute inset-8">
            {rows.map((r) => {
              const std = compositeStd(r.uncertainty)
              const size = 10 + (std / maxStd) * 28
              const heat = std / maxStd
              const isDeccan = r.supplier.name.toLowerCase().includes('deccan')
              return (
                <div
                  key={r.supplier_id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${toX(r.predicted_lead_time)}%`,
                    top: `${toY(r.predicted_defect_rate)}%`,
                  }}
                  title={`${r.supplier.name}\nlead ${r.predicted_lead_time.toFixed(2)}d ±${stdFromUncertainty(r.uncertainty, 'lead_time').toFixed(2)}\ndefect ${(r.predicted_defect_rate * 100).toFixed(2)}% ±${(stdFromUncertainty(r.uncertainty, 'defect_rate') * 100).toFixed(2)}pp`}
                >
                  <div
                    className={cn(
                      'rounded-full border',
                      isDeccan ? 'border-primary' : 'border-transparent',
                    )}
                    style={{
                      width: size,
                      height: size,
                      background: `oklch(${0.55 + heat * 0.2} ${0.08 + heat * 0.16} 55 / ${0.35 + heat * 0.5})`,
                      boxShadow: isDeccan
                        ? `0 0 0 ${6 + heat * 10}px oklch(0.78 0.14 75 / 0.18)`
                        : undefined,
                    }}
                  />
                  <div
                    className={cn(
                      'absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-[10px]',
                      isDeccan ? 'font-semibold text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {r.supplier.name.replace(' Botanicals', '').replace(' CMO Hyderabad', '')}
                  </div>
                </div>
              )
            })}
          </div>
          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider text-muted-foreground">
            predicted lead time (days)
          </span>
          <span className="absolute left-1 top-1/2 origin-left -translate-y-1/2 -rotate-90 text-[10px] uppercase tracking-wider text-muted-foreground">
            predicted defect rate
          </span>
        </div>
      </CardBody>
    </Card>
  )
}
