// pages/api/invite.js
// Admin-only endpoint to invite users via Supabase Auth.
// Uses the service role key (server-side only — never sent to browser).

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    // Verify the caller is an authenticated admin using the anon client
    const authHeader = req.headers.authorization
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' })

    const userClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return res.status(401).json({ error: 'Not authenticated' })

    // Check admin flag
    const { data: profile } = await userClient
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!profile?.is_admin) {
      return res.status(403).json({ error: 'Forbidden: admins only' })
    }

    // Use service-role client to send the invite email
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY   // Never expose this to the browser
    )

    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/set-password`,
    })

    if (error) throw error

    return res.status(200).json({ success: true, userId: data.user.id })
  } catch (err) {
    console.error('[invite]', err)
    return res.status(400).json({ error: err.message })
  }
}
