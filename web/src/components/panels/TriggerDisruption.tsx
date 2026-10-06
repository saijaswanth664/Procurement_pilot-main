import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase'
import type { Supplier } from '@/hooks/useDashboardData'

const TYPES = ['capacity', 'price', 'reliability'] as const

export function TriggerDisruption({
  suppliers,
  disabled,
}: {
  suppliers: Supplier[]
  disabled?: boolean
}) {
  const ayur = suppliers.find((s) => s.name.toLowerCase().includes('ayurform'))
  const [supplierId, setSupplierId] = useState<number | ''>('')
  const [type, setType] = useState<(typeof TYPES)[number]>('capacity')
  const [magnitude, setMagnitude] = useState(80)
  const [prepare, setPrepare] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const selected = useMemo(() => {
    if (supplierId !== '') return Number(supplierId)
    return ayur?.id ?? suppliers[0]?.id ?? 0
  }, [supplierId, ayur, suppliers])

  async function fire() {
    setBusy(true)
    setMsg(null)
    const { data, error } = await supabase.functions.invoke('trigger-disruption', {
      body: {
        supplier_id: selected,
        type,
        magnitude,
        prepare_bookable: prepare,
        compare_label: 'cost_aggressive',
      },
    })
    setBusy(false)
    if (error) {
      setMsg(error.message)
      return
    }
    const payload = data as { run_id?: string; reasoning?: string }
    setMsg(payload.run_id ? `Re-plan ${payload.run_id.slice(0, 8)}… live` : 'Triggered')
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Supplier
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          value={selected}
          onChange={(e) => setSupplierId(Number(e.target.value))}
          disabled={disabled}
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Type
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          value={type}
          onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          disabled={disabled}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Magnitude %
        <input
          type="number"
          className="h-9 w-20 rounded-md border border-border bg-background px-2 text-sm"
          value={magnitude}
          onChange={(e) => setMagnitude(Number(e.target.value))}
          disabled={disabled}
        />
      </label>
      <label className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={prepare}
          onChange={(e) => setPrepare(e.target.checked)}
          disabled={disabled}
        />
        prepare_bookable
      </label>
      <Button onClick={() => void fire()} disabled={disabled || busy || !selected}>
        {busy ? 'Re-planning…' : 'Trigger disruption'}
      </Button>
      {msg && <span className="max-w-xs text-xs text-primary">{msg}</span>}
    </div>
  )
}
