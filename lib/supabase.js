import { createClient } from '@supabase/supabase-js'

// Next.js uses NEXT_PUBLIC_ prefix (not VITE_)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ─── AUTH ────────────────────────────────────────────────────

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getProfile() {
  const user = await getCurrentUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  return data
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
}

// ─── ADMIN: INVITE USERS ─────────────────────────────────────
// Calls the Next.js API route /api/invite (not a Supabase Edge Function)
// because your app already uses Next.js API routes for everything.

export async function inviteUser(email) {
  const res = await fetch('/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Invite failed')
  return data
}

// ─── PORTFOLIO ───────────────────────────────────────────────
// Direct Supabase queries — RLS automatically filters by the
// logged-in user, so no user_id needed in the query itself.

export async function getPortfolio() {
  const { data, error } = await supabase
    .from('portfolio')
    .select('*')
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

export async function getPositions() {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function getTrades({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function getWatchlist() {
  const { data, error } = await supabase
    .from('watchlist')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}
