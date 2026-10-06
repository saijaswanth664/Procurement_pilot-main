import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { formatWhen } from '@/lib/format'
import type { Batch, Order, Supplier } from '@/hooks/useDashboardData'

const BRIDGE = import.meta.env.VITE_QC_BRIDGE_URL ?? '/qc-bridge'

export function BatchesPanel({
  batches,
  orders,
  suppliers,
  liveTick,
}: {
  batches: Batch[]
  orders: Order[]
  suppliers: Supplier[]
  liveTick: number
}) {
  const { profile } = useAuth()
  const lockedSupplier = profile?.role === 'supplier' ? profile.supplier_id : null
  const [supplierId, setSupplierId] = useState<number | ''>(lockedSupplier ?? '')
  const [orderId, setOrderId] = useState<number | ''>('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [bridgeNote, setBridgeNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)

  const orderChoices = useMemo(
    () => orders.filter((o) => (supplierId === '' ? true : o.supplier_id === Number(supplierId))),
    [orders, supplierId],
  )

  const names = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers])
  const detail = batches.find((b) => b.id === selected) ?? batches[0] ?? null

  async function ping() {
    try {
      const res = await fetch(`${BRIDGE}/health`)
      const h = (await res.json()) as {
        model?: string
        ollama_reachable?: boolean
        edge_functions_note?: string
      }
      setBridgeNote(
        h.ollama_reachable
          ? `Bridge up · ${h.model}`
          : `Bridge up but Ollama not reachable. ${h.edge_functions_note ?? ''}`,
      )
    } catch {
      setBridgeNote('QC bridge offline (python scripts/qc_bridge.py). Edge Functions cannot see local Ollama.')
    }
  }

  useEffect(() => {
    void ping()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const sid = Number(supplierId || lockedSupplier)
    if (!sid || !file) {
      setMsg('Pick a supplier and a photo.')
      return
    }
    setBusy(true)
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) {
      setBusy(false)
      setMsg('Sign in required.')
      return
    }
    const body = new FormData()
    body.append('photo', file)
    body.append('supplier_id', String(sid))
    if (orderId !== '') body.append('order_id', String(orderId))
    try {
      const res = await fetch(`${BRIDGE}/inspect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      const json = (await res.json()) as {
        error?: string
        detail?: string
        batch?: { id: number }
        vlm?: { parsed?: { defect_flag?: boolean } }
      }
      if (!res.ok) {
        setMsg(typeof json.detail === 'string' ? json.detail : json.error ?? `HTTP ${res.status}`)
        return
      }
      const flag = json.vlm?.parsed?.defect_flag
      setMsg(
        `Batch #${json.batch?.id} · ${flag ? 'FAIL defect flagged' : 'PASS'} · PDF uploaded`,
      )
      setFile(null)
      if (json.batch?.id) setSelected(json.batch.id)
    } catch (err) {
      setMsg(
        err instanceof Error
          ? `${err.message} — start the local QC bridge: python scripts/qc_bridge.py`
          : 'bridge unreachable',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <div>
          <CardTitle>Incoming QC batches</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Photo → Cloudinary → local {`qwen2.5vl:7b`} → PDF. Edge Functions cannot reach Ollama on
            this laptop; the Vite proxy talks to scripts/qc_bridge.py.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void ping()}>
          Bridge status
        </Button>
      </CardHeader>
      <CardBody className="space-y-4">
        {bridgeNote && <p className="text-xs text-primary">{bridgeNote}</p>}
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Supplier
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value ? Number(e.target.value) : '')
                setOrderId('')
              }}
              disabled={lockedSupplier != null}
            >
              <option value="">Select…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Order
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">New QC intake order</option>
              {orderChoices.map((o) => (
                <option key={o.id} value={o.id}>
                  #{o.id} {o.sku} ({o.status})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Photo
            <input
              type="file"
              accept="image/*"
              className="h-9 max-w-[220px] text-xs text-foreground"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Inspecting…' : 'Upload & inspect'}
          </Button>
          {msg && <span className="max-w-md text-xs text-primary">{msg}</span>}
        </form>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="max-h-[420px] space-y-1 overflow-y-auto">
            {batches.length === 0 && (
              <li className="text-sm text-muted-foreground">No batches yet.</li>
            )}
            {batches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setSelected(b.id)}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                    detail?.id === b.id
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border bg-background/40'
                  }`}
                >
                  <span>
                    #{b.id} · {names.get(b.supplier_id) ?? `supplier ${b.supplier_id}`}
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                      {formatWhen(b.created_at)}
                    </span>
                  </span>
                  <span
                    className={
                      b.defect_flag
                        ? 'text-xs font-medium text-destructive'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {b.defect_flag == null ? '—' : b.defect_flag ? 'FAIL' : 'PASS'}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {detail ? (
            <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
              {detail.photo_url && (
                <img
                  src={detail.photo_url}
                  alt={`Batch ${detail.id}`}
                  className="max-h-56 w-full rounded-md object-cover"
                />
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={
                    detail.defect_flag
                      ? 'rounded-full border border-destructive/50 px-2 py-0.5 text-destructive'
                      : 'rounded-full border border-primary/40 px-2 py-0.5 text-primary'
                  }
                >
                  {detail.defect_flag ? 'defect flagged' : 'no defect flagged'}
                </span>
                <span className="text-muted-foreground">
                  confidence{' '}
                  {detail.defect_confidence == null
                    ? '—'
                    : Number(detail.defect_confidence).toFixed(2)}
                </span>
                {detail.reported_pdf_url && (
                  <a
                    className="text-primary underline underline-offset-2"
                    href={detail.reported_pdf_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download QC PDF
                  </a>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {detail.vlm_description ?? 'No description yet.'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Select a batch to inspect the report.</p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
