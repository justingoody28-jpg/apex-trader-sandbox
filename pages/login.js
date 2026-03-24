// pages/login.js  (or inline at top of pages/index.js — see note below)
// Shows when no auth session exists.

import { useState } from 'react'
import { signIn } from '../lib/supabase'

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signIn(email, password)
      onLogin?.()
    } catch (err) {
      setError(err.message || 'Login failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0f',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{
        background: '#13131a',
        border: '1px solid #2a2a3a',
        borderRadius: 12,
        padding: '40px 48px',
        width: 380,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
      }}>
        <h1 style={{ color: '#fff', margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>
          Apex Trader
        </h1>
        <p style={{ color: '#666', margin: '0 0 32px', fontSize: 14 }}>
          Sign in to your account
        </p>

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ color: '#aaa', fontSize: 13, display: 'block', marginBottom: 6 }}>
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@example.com"
              style={{
                width: '100%',
                background: '#1e1e2e',
                border: '1px solid #2a2a3a',
                borderRadius: 8,
                padding: '10px 12px',
                color: '#fff',
                fontSize: 14,
                boxSizing: 'border-box',
                outline: 'none'
              }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 24 }}>
            <span style={{ color: '#aaa', fontSize: 13, display: 'block', marginBottom: 6 }}>
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="Password"
              style={{
                width: '100%',
                background: '#1e1e2e',
                border: '1px solid #2a2a3a',
                borderRadius: 8,
                padding: '10px 12px',
                color: '#fff',
                fontSize: 14,
                boxSizing: 'border-box',
                outline: 'none'
              }}
            />
          </label>

          {error && (
            <p style={{
              color: '#ff4d6d',
              background: 'rgba(255,77,109,0.1)',
              border: '1px solid rgba(255,77,109,0.3)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 13,
              marginBottom: 16
            }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              background: loading ? '#2a2a3a' : '#6c63ff',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '12px',
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s'
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p style={{ color: '#555', fontSize: 12, marginTop: 24, textAlign: 'center' }}>
          Don't have an account? Contact your administrator.
        </p>
      </div>
    </div>
  )
}
