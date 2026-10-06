import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/auth/AuthProvider'

export function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('owner@ayuranest.demo')
  const [password, setPassword] = useState('AyuraNest-demo!')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const msg = await signIn(email, password)
    setBusy(false)
    if (msg) setError(msg)
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-xl"
      >
        <p className="text-[11px] uppercase tracking-[0.2em] text-primary">AyuraNest</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">ProcurementPilot</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Business-owner session required to read strategies and the decision log. Role lives in
          profiles, not JWT user_metadata.
        </p>
        <label className="mt-5 grid gap-1 text-xs text-muted-foreground">
          Email
          <input
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
          Password
          <input
            type="password"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <Button className="mt-5 w-full" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Enter ops floor'}
        </Button>
      </form>
    </div>
  )
}
