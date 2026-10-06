import { useAnimatedNumber } from '@/hooks/useAnimatedNumber'
import { formatInr, formatRisk } from '@/lib/format'
import { cn } from '@/lib/utils'

export function LiveNumber({
  value,
  kind,
  className,
}: {
  value: number | null | undefined
  kind: 'inr' | 'risk' | 'raw'
  className?: string
}) {
  const n = useAnimatedNumber(typeof value === 'number' && Number.isFinite(value) ? value : 0)
  if (value == null || (typeof value === 'number' && Number.isNaN(value))) {
    return <span className={cn('tabular', className)}>—</span>
  }
  const text =
    kind === 'inr' ? formatInr(n, true) : kind === 'risk' ? formatRisk(n) : n.toFixed(3)
  return <span className={cn('tabular', className)}>{text}</span>
}
