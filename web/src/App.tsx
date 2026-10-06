import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { Dashboard } from '@/pages/Dashboard'
import { Login } from '@/pages/Login'

function Gate() {
  const { user, profile, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
        Restoring session…
      </div>
    )
  }
  if (!user || !profile) return <Login />
  return <Dashboard />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
