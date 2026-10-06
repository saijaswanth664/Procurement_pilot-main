import { useState, useMemo, type FormEvent } from 'react'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { formatWhen } from '@/lib/format'
import type { Message, Supplier } from '@/hooks/useDashboardData'

function getThreadId(supplierId: number) {
  // Deterministic thread ID per supplier for the hackathon
  return `00000000-0000-0000-0000-${supplierId.toString().padStart(12, '0')}`
}

export function ChatPanel({
  messages,
  suppliers,
  liveTick,
}: {
  messages: Message[]
  suppliers: Supplier[]
  liveTick: number
}) {
  const { profile, user } = useAuth()
  const lockedSupplier = profile?.role === 'supplier' ? profile.supplier_id : null
  const [supplierId, setSupplierId] = useState<number | ''>(lockedSupplier ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const threadId = supplierId ? getThreadId(Number(supplierId)) : null
  const threadMessages = useMemo(
    () => messages.filter((m) => m.thread_id === threadId),
    [messages, threadId]
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || !threadId || !user || !profile) return
    setBusy(true)
    try {
      await supabase.from('messages').insert({
        thread_id: threadId,
        sender_id: user.id,
        sender_role: profile.role,
        body: text.trim(),
        flagged_for_dashboard: false,
        classification_status: 'pending',
      })
      setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={liveTick ? 'flash-live' : undefined}>
      <CardHeader>
        <CardTitle>Supplier Chat</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {!lockedSupplier && (
          <label className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Chatting with:
            <select
              className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-2 text-sm"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Select a supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {supplierId ? (
          <div className="flex h-[400px] flex-col rounded-md border border-border bg-background/40">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {threadMessages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No messages yet.</p>
              ) : (
                threadMessages.map((msg) => {
                  const isMe = msg.sender_id === user?.id
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col max-w-[75%] ${isMe ? 'ml-auto items-end' : 'mr-auto items-start'}`}
                    >
                      <span className="text-[10px] text-muted-foreground mb-1 uppercase">
                        {msg.sender_role} · {formatWhen(msg.created_at)}
                      </span>
                      <div
                        className={`rounded-lg px-3 py-2 text-sm ${
                          isMe
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/50 text-foreground'
                        }`}
                      >
                        {msg.body}
                      </div>
                      {msg.flagged_for_dashboard && (
                        <span className="mt-1 text-[10px] text-destructive font-medium uppercase tracking-wider">
                          🚨 Escalated to owner
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            <div className="border-t border-border p-3">
              <form onSubmit={onSubmit} className="flex gap-2">
                <input
                  type="text"
                  className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                  placeholder="Type a message..."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={busy || !text.trim()}>
                  Send
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a supplier to start chatting.</p>
        )}
      </CardBody>
    </Card>
  )
}
