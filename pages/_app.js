// pages/_app.js
// This is the Next.js app wrapper — replaces or creates this file.
// The AuthProvider goes here so every page has access to the session.

import { useState, useEffect, createContext, useContext } from 'react'
import { supabase, getProfile } from '../lib/supabase'

// ─── Auth Context ─────────────────────────────────────────────
const AuthContext = createContext(null)

function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)   // undefined = still loading
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    // Hydrate from existing session on first load
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
    })

    // Listen for login/logout/token refresh
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        const authUser = session?.user ?? null
        setUser(authUser)
        if (authUser) {
          const p = await getProfile()
          setProfile(p)
        } else {
          setProfile(null)
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // Load profile when session is restored from cookie on page load
  useEffect(() => {
    if (user && !profile) {
      getProfile().then(setProfile)
    }
  }, [user])

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      isAdmin: profile?.is_admin === true,
      loading: user === undefined,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider (pages/_app.js)')
  return ctx
}

// ─── App Root ─────────────────────────────────────────────────
export default function App({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  )
}
