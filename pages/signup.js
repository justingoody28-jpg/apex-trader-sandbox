import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function SignupPage() {
  var [email, setEmail] = useState('justingoody28@gmail.com')
  var [password, setPassword] = useState('')
  var [done, setDone] = useState(false)
  var [error, setError] = useState(null)
  var [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      var res = await supabase.auth.signUp({ email, password })
      if (res.error) throw res.error
      setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  var s = {
    page: { minHeight:'100vh', background:'#030712', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'IBM Plex Mono','Courier New',monospace" },
    card: { background:'#0a0f1a', border:'1px solid #1e293b', borderRadius:12, padding:'40px 48px', width:400 },
    title: { color:'#f1f5f9', fontSize:22, fontWeight:800, marginBottom:4 },
    sub: { color:'#334155', fontSize:12, marginBottom:28 },
    label: { display:'block', fontSize:9, color:'#334155', letterSpacing:2, marginBottom:6 },
    input: { width:'100%', background:'#030712', border:'1px solid #1e293b', color:'#f1f5f9', borderRadius:7, padding:'10px 12px', fontSize:13, outline:'none', fontFamily:'monospace', boxSizing:'border-box', marginBottom:14 },
    btn: { width:'100%', background:'linear-gradient(135deg,#1d4ed8,#7c3aed)', border:'none', color:'#fff', borderRadius:8, padding:12, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'monospace' },
    err: { color:'#f87171', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:6, padding:'8px 12px', fontSize:12, marginBottom:14 },
    ok: { color:'#4ade80', background:'#052e16', border:'1px solid #16a34a', borderRadius:8, padding:'16px', fontSize:13, lineHeight:1.7 },
    warn: { color:'#f59e0b', background:'#1c1400', border:'1px solid #d97706', borderRadius:8, padding:'12px', fontSize:11, marginBottom:20, lineHeight:1.6 },
  }

  if (done) return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.title}>Account Created!</div>
        <div style={{...s.ok, marginTop:20}}>
          Your account is ready.<br/><br/>
          1. Go to <a href="/" style={{color:'#60a5fa'}}>apex-trader-sandbox.vercel.app</a> and sign in<br/>
          2. Then run this in Supabase SQL Editor:<br/>
          <span style={{color:'#22c55e', display:'block', marginTop:8, background:'#030712', padding:'8px', borderRadius:4, fontSize:11}}>
            UPDATE profiles SET is_admin = TRUE WHERE email = '{email}';
          </span>
        </div>
      </div>
    </div>
  )

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.title}>Create Account</div>
        <div style={s.sub}>One-time setup — creates your Apex Trader login</div>
        <div style={s.warn}>
          DELETE this page after signing up!<br/>
          Push a blank file or re-push login.js to pages/signup.js
        </div>
        <form onSubmit={handleSubmit}>
          <label style={s.label}>EMAIL</label>
          <input style={s.input} type="email" value={email} onChange={function(e){setEmail(e.target.value)}} required />
          <label style={s.label}>PASSWORD (choose something strong)</label>
          <input style={s.input} type="password" value={password} onChange={function(e){setPassword(e.target.value)}} required placeholder="Min 8 characters" minLength={8} />
          {error && <div style={s.err}>{error}</div>}
          <button style={s.btn} type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create My Account'}
          </button>
        </form>
      </div>
    </div>
  )
}
