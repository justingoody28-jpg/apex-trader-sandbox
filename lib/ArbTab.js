// lib/ArbTab.js
// Prediction Market Arb Module for Apex Trader Sandbox.
// Completely isolated visual identity — own theme, own layout.
// Shares only the supabase prop from the parent app.
//
// Three sub-tabs:
//   Scanner     — live Kalshi x Polymarket mispricing detector
//   Paper Trade — enter/exit virtual arb positions (persisted to Supabase)
//   Backtest    — deterministic 90-day simulation with self-tuning suggestions

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Theme (completely isolated from Apex's equity trader UI) ─────────────────
const T = {
  bg:      '#05080f',
  surface: '#0a0f1a',
  card:    '#0d1526',
  border:  '#1a2840',
  accent:  '#3b82f6',    // blue — distinct from Apex's green equity theme
  green:   '#10b981',
  yellow:  '#f59e0b',
  red:     '#ef4444',
  purple:  '#8b5cf6',
  cyan:    '#06b6d4',
  text:    '#cbd5e1',
  subtext: '#64748b',
  muted:   '#334155',
  mono:    "'Courier New', monospace",
  sans:    "system-ui, -apple-system, sans-serif",
};

const CAT_COLOR = {
  Crypto:      T.cyan,
  Macro:       T.yellow,
  Equities:    T.accent,
  Politics:    T.purple,
  Geopolitics: '#f97316',
  Tech:        '#a78bfa',
  Other:       T.subtext,
};

// ─── Deterministic PRNG ───────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── Backtester ───────────────────────────────────────────────────────────────
function runBacktest(p) {
  const feeDrag = p.feeDragCents / 100;
  const minEdge = p.minEdgeCents / 100;
  const rng = mulberry32(p.seed || 42);
  function norm(mean, std) {
    return mean + std * Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng());
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const trades = [], equity = [p.notional * 10];
  let open = [], cash = p.notional * 10, maxEq = cash, maxDD = 0;

  for (let day = 0; day < p.daysToSimulate; day++) {
    const newOps = Math.round(clamp(norm(p.opPerDay, 1.5), 0, 8));
    for (let i = 0; i < newOps; i++) {
      const rawDiv = clamp(norm(p.divMean, p.divStd), 1, 25) / 100;
      const edge = rawDiv - feeDrag;
      if (edge < minEdge || cash < p.notional) continue;
      open.push({
        cd: day + Math.round(clamp(norm(p.convergeDays, 3), 1, 30)),
        rawDiv, edge, notional: p.notional,
        outcome: rng() < 0.80 ? 'conv' : rng() < 0.5 ? 'div' : 'scratch',
      });
      cash -= p.notional;
    }
    open = open.filter(pos => {
      if (day < pos.cd) return true;
      const pnl = pos.outcome === 'conv' ? (pos.rawDiv - feeDrag) * pos.notional
        : pos.outcome === 'div' ? -(feeDrag + pos.rawDiv * 0.3) * pos.notional
        : -feeDrag * pos.notional;
      cash += pos.notional + pnl;
      trades.push({ hold: pos.cd - day + p.convergeDays, pnl, pct: pnl / pos.notional,
        result: pnl > 0 ? 'W' : pnl < -(feeDrag * pos.notional * 0.5) ? 'L' : 'S' });
      return false;
    });
    const eq = cash + open.reduce((s, p) => s + p.notional, 0);
    equity.push(eq);
    if (eq > maxEq) maxEq = eq;
    const dd = (maxEq - eq) / maxEq;
    if (dd > maxDD) maxDD = dd;
  }

  const wins = trades.filter(t => t.result === 'W').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const rets = trades.map(t => t.pct);
  const avgR = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const stdR = Math.sqrt(rets.reduce((s, r) => s + (r - avgR) ** 2, 0) / (rets.length || 1));
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252 / p.convergeDays) : 0;
  const gW = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gL = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

  return {
    trades, equity,
    stats: {
      n: trades.length, wins, losses: trades.filter(t => t.result === 'L').length,
      winRate: trades.length ? wins / trades.length : 0,
      totalPnl: +totalPnl.toFixed(2),
      totalReturn: +((equity[equity.length - 1] - equity[0]) / equity[0] * 100).toFixed(2),
      maxDD: +(maxDD * 100).toFixed(2),
      sharpe: +sharpe.toFixed(3),
      pf: +(gL > 0 ? gW / gL : gW > 0 ? 99 : 0).toFixed(3),
      avgHold: trades.length ? +(trades.reduce((s, t) => s + t.hold, 0) / trades.length).toFixed(1) : 0,
    },
  };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
const dbLoad = async (sb, table, filters = {}) => {
  let q = sb.from(table).select('*');
  Object.entries(filters).forEach(([k, v]) => { q = q.eq(k, v); });
  const { data } = await q.order('id', { ascending: false }).limit(100);
  return data || [];
};

// ─── Tiny UI atoms ────────────────────────────────────────────────────────────
const Pill = ({ label, color = T.accent }) => (
  <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 3, border: `1px solid ${color}40`,
    color, fontFamily: T.mono, letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>{label}</span>
);

const Num = ({ v, digits = 2, color, suffix = '' }) => (
  <span style={{ fontFamily: T.mono, fontWeight: 700, color: color ||
    (v > 0 ? T.green : v < 0 ? T.red : T.subtext) }}>
    {v > 0 ? '+' : ''}{typeof v === 'number' ? v.toFixed(digits) : v}{suffix}
  </span>
);

const KV = ({ k, v, vColor }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.1em' }}>{k}</div>
    <div style={{ fontSize: 18, fontWeight: 800, color: vColor || T.text, fontFamily: T.mono }}>{v}</div>
  </div>
);

const Divider = () => <div style={{ height: 1, background: T.border, margin: '16px 0' }} />;

const Btn = ({ children, onClick, variant = 'default', disabled = false, small = false }) => {
  const variants = {
    default: { bg: `${T.accent}18`, border: `${T.accent}50`, color: T.accent },
    success: { bg: `${T.green}18`,  border: `${T.green}50`,  color: T.green  },
    danger:  { bg: `${T.red}18`,    border: `${T.red}50`,    color: T.red    },
    ghost:   { bg: 'transparent',   border: T.border,         color: T.subtext },
  };
  const s = variants[variant] || variants.default;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? '4px 12px' : '7px 18px',
      fontSize: small ? 10 : 12,
      background: s.bg, border: `1px solid ${s.border}`, color: disabled ? T.muted : s.color,
      borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: T.mono, letterSpacing: '0.05em', opacity: disabled ? 0.5 : 1,
    }}>{children}</button>
  );
};

const Slider = ({ label, value, min, max, step, onChange, color = T.accent, unit = '' }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.1em' }}>{label.toUpperCase()}</div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)}
        style={{ flex: 1, accentColor: color, height: 3 }} />
      <span style={{ fontSize: 12, color, fontFamily: T.mono, minWidth: 36 }}>{value}{unit}</span>
    </div>
  </label>
);

// ─── Equity curve SVG ─────────────────────────────────────────────────────────
const EquityCurve = ({ equity, height = 60 }) => {
  if (!equity || equity.length < 2) return null;
  const W = 400, H = height;
  const lo = Math.min(...equity), hi = Math.max(...equity), rng = hi - lo || 1;
  const pts = equity.map((v, i) =>
    `${(i / (equity.length - 1)) * W},${H - ((v - lo) / rng) * (H - 4) - 2}`
  ).join(' ');
  const isUp = equity[equity.length - 1] >= equity[0];
  const stroke = isUp ? T.green : T.red;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height, display: 'block' }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
};

// ─── Scanner sub-tab ──────────────────────────────────────────────────────────
function Scanner({ supabase }) {
  const [pairs, setPairs]     = useState([]);
  const [meta, setMeta]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState(null);
  const [feeDrag, setFeeDrag] = useState(5);
  const [minEdge, setMinEdge] = useState(3);
  const [cat, setCat]         = useState('All');
  const timer = useRef(null);
  const CATS = ['All', 'Crypto', 'Macro', 'Equities', 'Politics', 'Geopolitics', 'Tech'];

  const fetch_ = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/arb?feeDrag=${feeDrag}&threshold=0.22`);
      if (!r.ok) throw new Error(`API ${r.status}`);
      const d = await r.json();
      setPairs(d.pairs || []); setMeta(d.meta || null);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [feeDrag]);

  useEffect(() => {
    fetch_();
    timer.current = setInterval(fetch_, 30000);
    return () => clearInterval(timer.current);
  }, [fetch_]);

  async function enterPaperTrade(pair) {
    if (!supabase) return alert('Supabase not connected');
    await supabase.from('arb_positions').insert([{
      pair_id: pair.id, title: pair.kalshi.title, category: pair.category,
      buy_on: pair.buyOn, sell_on: pair.sellOn,
      entry_k_price: pair.kPrice, entry_p_price: pair.pPrice,
      raw_div: pair.rawDivergence, implied_edge: pair.impliedEdge,
      fee_drag: pair.feeDrag, notional: 100, status: 'open',
    }]);
    alert(`Position opened: BUY ${pair.buyOn} @ ${(pair.kPrice * 100).toFixed(0)}c`);
  }

  const visible = pairs.filter(p =>
    (cat === 'All' || p.category === cat) && p.impliedEdge * 100 >= minEdge - 5
  );
  const edgePairs = visible.filter(p => p.hasEdge);

  return (
    <div>
      {/* Controls bar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16,
        padding: '12px 16px', background: T.surface, borderRadius: 8, border: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
          {CATS.map(c => (
            <button key={c} onClick={() => setCat(c)} style={{
              padding: '3px 12px', fontSize: 10, borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${cat === c ? CAT_COLOR[c] || T.accent : T.border}`,
              background: cat === c ? `${CAT_COLOR[c] || T.accent}18` : 'transparent',
              color: cat === c ? CAT_COLOR[c] || T.accent : T.subtext,
              fontFamily: T.mono,
            }}>{c}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono, display: 'flex', alignItems: 'center', gap: 8 }}>
            FEE
            <input type="range" min={0} max={12} step={1} value={feeDrag} onChange={e => setFeeDrag(+e.target.value)}
              style={{ width: 60, accentColor: T.yellow }} />
            <span style={{ color: T.yellow }}>{feeDrag}c</span>
          </div>
          <div style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono, display: 'flex', alignItems: 'center', gap: 8 }}>
            MIN
            <input type="range" min={0} max={15} step={1} value={minEdge} onChange={e => setMinEdge(+e.target.value)}
              style={{ width: 60, accentColor: T.green }} />
            <span style={{ color: T.green }}>{minEdge}c</span>
          </div>
          <Btn onClick={fetch_} small variant={loading ? 'ghost' : 'default'}>{loading ? '...' : 'REFRESH'}</Btn>
        </div>
      </div>

      {/* Stats strip */}
      {meta && (
        <div style={{ display: 'flex', gap: 20, padding: '10px 16px', marginBottom: 16,
          background: T.surface, borderRadius: 8, border: `1px solid ${T.border}` }}>
          <KV k="KALSHI" v={meta.kalshiCount} vColor={T.cyan} />
          <KV k="POLYMARKET" v={meta.polyCount} vColor={T.purple} />
          <KV k="PAIRS" v={meta.pairsFound} />
          <KV k="WITH EDGE" v={meta.withEdge} vColor={T.green} />
          <div style={{ marginLeft: 'auto', fontSize: 10, color: T.muted, fontFamily: T.mono, alignSelf: 'flex-end' }}>
            {meta.cached ? 'cached · ' : ''}{meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleTimeString() : ''}
          </div>
        </div>
      )}

      {/* Error */}
      {err && (
        <div style={{ padding: '10px 14px', background: `${T.red}0d`, border: `1px solid ${T.red}33`,
          borderRadius: 6, marginBottom: 16, fontSize: 11, color: T.red, fontFamily: T.mono }}>
          {err} — verify /api/arb.js is deployed
        </div>
      )}

      {/* Cards */}
      {visible.length === 0 && !loading && !err ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: T.muted, fontFamily: T.mono, fontSize: 12 }}>
          NO PAIRS MATCH CURRENT FILTERS
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 10 }}>
          {visible.map(pair => {
            const accent = CAT_COLOR[pair.category] || T.subtext;
            return (
              <div key={pair.id} style={{ background: T.card, border: `1px solid ${T.border}`,
                borderLeft: `3px solid ${pair.hasEdge ? accent : T.red}`, borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill label={pair.category.toUpperCase()} color={accent} />
                    <Pill label={`${Math.round(pair.matchScore * 100)}% MATCH`} color={T.subtext} />
                  </div>
                  <Pill label={pair.hasEdge ? 'EDGE' : 'NO EDGE'} color={pair.hasEdge ? T.green : T.red} />
                </div>
                <div style={{ fontSize: 12, color: T.text, lineHeight: 1.5, marginBottom: 12, fontWeight: 500 }}>
                  {pair.kalshi.title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', background: '#ffffff05',
                  borderRadius: 6, padding: '8px 14px', marginBottom: 10 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: accent, fontFamily: T.mono }}>
                      {Math.round(pair.kPrice * 100)}<span style={{ fontSize: 12, opacity: 0.5 }}>c</span>
                    </div>
                    <div style={{ fontSize: 9, color: T.subtext }}>KALSHI</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ color: T.muted, fontSize: 16 }}>&#8644;</div>
                    <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono }}>
                      {Math.round(pair.rawDivergence * 100)}c gap
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: accent, fontFamily: T.mono }}>
                      {Math.round(pair.pPrice * 100)}<span style={{ fontSize: 12, opacity: 0.5 }}>c</span>
                    </div>
                    <div style={{ fontSize: 9, color: T.subtext }}>POLYMARKET</div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, fontFamily: T.mono,
                    color: pair.hasEdge ? T.green : T.red }}>
                    NET {pair.hasEdge ? '+' : ''}{(pair.impliedEdge * 100).toFixed(1)}c edge
                    <span style={{ color: T.muted }}> after {Math.round(pair.feeDrag * 100)}c fees</span>
                  </div>
                  {pair.hasEdge && (
                    <Btn small onClick={() => enterPaperTrade(pair)} variant="success">+ PAPER</Btn>
                  )}
                </div>
                {pair.hasEdge && (
                  <div style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono, marginTop: 6,
                    paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
                    BUY {pair.buyOn.toUpperCase()} · SELL {pair.sellOn.toUpperCase()}
                    {pair.kalshi.url && <a href={pair.kalshi.url} target="_blank" rel="noopener noreferrer"
                      style={{ marginLeft: 12, color: `${accent}80`, textDecoration: 'none' }}>K&#8599;</a>}
                    {pair.poly.url && <a href={pair.poly.url} target="_blank" rel="noopener noreferrer"
                      style={{ marginLeft: 8, color: `${accent}80`, textDecoration: 'none' }}>P&#8599;</a>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Paper Trader sub-tab ─────────────────────────────────────────────────────
function PaperTrader({ supabase }) {
  const [positions, setPositions] = useState([]);
  const [history, setHistory]     = useState([]);
  const [loading, setLoading]     = useState(true);

  async function reload() {
    if (!supabase) return;
    const [p, h] = await Promise.all([
      dbLoad(supabase, 'arb_positions', { status: 'open' }),
      dbLoad(supabase, 'arb_trades'),
    ]);
    setPositions(p); setHistory(h); setLoading(false);
  }

  useEffect(() => { reload(); }, [supabase]);

  async function closePos(pos, exitK, exitP) {
    const pnl = +((Math.abs(exitK - exitP) - pos.fee_drag) * pos.notional).toFixed(2);
    await supabase.from('arb_positions').update({
      status: 'closed', closed_at: new Date().toISOString(),
      exit_k_price: exitK, exit_p_price: exitP, pnl,
    }).eq('id', pos.id);
    await supabase.from('arb_trades').insert([{
      position_id: pos.id, pair_id: pos.pair_id, title: pos.title, category: pos.category,
      buy_on: pos.buy_on, sell_on: pos.sell_on,
      entry_k_price: pos.entry_k_price, entry_p_price: pos.entry_p_price,
      exit_k_price: exitK, exit_p_price: exitP,
      raw_div_entry: pos.raw_div, raw_div_exit: +Math.abs(exitK - exitP).toFixed(4),
      implied_edge: pos.implied_edge, fee_drag: pos.fee_drag, notional: pos.notional,
      pnl, pnl_pct: +(pnl / pos.notional).toFixed(4),
      hold_minutes: Math.round((Date.now() - new Date(pos.opened_at)) / 60000),
      result: pnl > 0 ? 'win' : pnl < -(pos.fee_drag * pos.notional * 0.5) ? 'loss' : 'scratch',
    }]);
    reload();
  }

  const totalPnl  = history.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate   = history.length ? history.filter(t => t.result === 'win').length / history.length : 0;

  if (!supabase) return (
    <div style={{ color: T.subtext, fontFamily: T.mono, fontSize: 12, padding: 24 }}>
      Pass supabase prop to ArbTab to enable paper trading persistence.
    </div>
  );

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { k: 'OPEN', v: positions.length, c: T.accent },
          { k: 'TOTAL TRADES', v: history.length, c: T.text },
          { k: 'WIN RATE', v: `${(winRate * 100).toFixed(0)}%`, c: winRate > 0.5 ? T.green : T.yellow },
          { k: 'TOTAL P&L', v: `$${totalPnl.toFixed(2)}`, c: totalPnl >= 0 ? T.green : T.red },
        ].map(s => (
          <div key={s.k} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: '14px 16px' }}>
            <KV k={s.k} v={s.v} vColor={s.c} />
          </div>
        ))}
      </div>

      {/* Open positions */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.15em', marginBottom: 10 }}>
          OPEN POSITIONS
          <span style={{ marginLeft: 12 }}><Btn small onClick={reload} variant="ghost">RELOAD</Btn></span>
        </div>
        {positions.length === 0 ? (
          <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, padding: '16px 0' }}>
            No open positions. Use the Scanner tab to paper trade an opportunity.
          </div>
        ) : positions.map(pos => <PosRow key={pos.id} pos={pos} onClose={closePos} />)}
      </div>

      <Divider />

      {/* History table */}
      <div style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.15em', marginBottom: 10 }}>
        TRADE HISTORY
      </div>
      {history.length === 0 ? (
        <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>No completed trades yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: T.subtext, textAlign: 'left', fontFamily: T.mono }}>
                {['MARKET','CAT','ENTRY DIV','EXIT DIV','P&L','RESULT','HOLD'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', borderBottom: `1px solid ${T.border}`, fontSize: 9, letterSpacing: '0.1em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map(t => (
                <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}20` }}>
                  <td style={{ padding: '8px 10px', color: T.text, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</td>
                  <td style={{ padding: '8px 10px' }}><Pill label={(t.category || '').substring(0,4).toUpperCase()} color={CAT_COLOR[t.category] || T.subtext} /></td>
                  <td style={{ padding: '8px 10px', color: T.subtext, fontFamily: T.mono }}>{t.raw_div_entry ? `${(t.raw_div_entry*100).toFixed(1)}c` : '-'}</td>
                  <td style={{ padding: '8px 10px', color: T.subtext, fontFamily: T.mono }}>{t.raw_div_exit ? `${(t.raw_div_exit*100).toFixed(1)}c` : '-'}</td>
                  <td style={{ padding: '8px 10px', fontFamily: T.mono, fontWeight: 700, color: (t.pnl||0)>=0?T.green:T.red }}>${(t.pnl||0).toFixed(2)}</td>
                  <td style={{ padding: '8px 10px' }}><Pill label={(t.result||'').toUpperCase()} color={t.result==='win'?T.green:t.result==='loss'?T.red:T.yellow} /></td>
                  <td style={{ padding: '8px 10px', color: T.muted, fontFamily: T.mono }}>{t.hold_minutes ? `${t.hold_minutes}m` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PosRow({ pos, onClose }) {
  const [expanded, setExpanded] = useState(false);
  const [exitK, setExitK] = useState(pos.entry_k_price);
  const [exitP, setExitP] = useState(pos.entry_p_price);
  const projPnl = ((Math.abs(exitK - exitP) - pos.fee_drag) * pos.notional);
  const accent = CAT_COLOR[pos.category] || T.subtext;

  return (
    <div style={{ border: `1px solid ${T.border}`, borderLeft: `3px solid ${accent}`,
      borderRadius: 8, padding: '12px 16px', marginBottom: 8, background: T.card }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 12, color: T.text, marginBottom: 6, fontWeight: 500 }}>{pos.title}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Pill label={pos.category?.toUpperCase()} color={accent} />
            <span style={{ fontSize: 10, color: T.subtext, fontFamily: T.mono }}>
              BUY {pos.buy_on} · entry edge +{(pos.implied_edge * 100).toFixed(1)}c · $100 notional
            </span>
          </div>
        </div>
        <Btn small onClick={() => setExpanded(!expanded)} variant={expanded ? 'ghost' : 'default'}>
          {expanded ? 'CANCEL' : 'CLOSE OUT'}
        </Btn>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`,
          display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {[['EXIT KALSHI', exitK, setExitK], ['EXIT POLY', exitP, setExitP]].map(([lbl, val, set]) => (
            <label key={lbl} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.1em' }}>{lbl} PRICE (0-1)</span>
              <input type="number" min={0.01} max={0.99} step={0.01} value={val}
                onChange={e => set(+e.target.value)}
                style={{ width: 90, background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, padding: '6px 10px', borderRadius: 5, fontFamily: T.mono, fontSize: 14 }} />
            </label>
          ))}
          <div>
            <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, marginBottom: 4 }}>PROJECTED P&L</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: T.mono, color: projPnl>=0?T.green:T.red }}>
              ${projPnl.toFixed(2)}
            </div>
          </div>
          <Btn onClick={() => onClose(pos, exitK, exitP)} variant={projPnl >= 0 ? 'success' : 'danger'}>
            CONFIRM CLOSE
          </Btn>
        </div>
      )}
    </div>
  );
}

// ─── Backtester sub-tab ───────────────────────────────────────────────────────
function Backtester({ supabase }) {
  const DEF = { feeDragCents: 5, minEdgeCents: 3, notional: 100, daysToSimulate: 90,
    opPerDay: 3, convergeDays: 5, divMean: 8, divStd: 4, seed: 42 };
  const [p, setP]       = useState(DEF);
  const [result, setR]  = useState(null);
  const [running, setR2] = useState(false);

  function param(key, val) { setP(prev => ({ ...prev, [key]: val })); }

  function run() {
    setR2(true);
    setTimeout(() => {
      const r = runBacktest(p);
      setR(r);
      if (supabase) {
        supabase.from('arb_backtest_runs').insert([{
          fee_drag_cents: p.feeDragCents, match_threshold: 0.22, min_edge_cents: p.minEdgeCents,
          total_trades: r.stats.n, wins: r.stats.wins, losses: r.stats.losses,
          win_rate: r.stats.winRate, total_pnl: r.stats.totalPnl, avg_pnl: r.stats.avgPnl,
          avg_hold_hrs: r.stats.avgHold * 24, max_drawdown: r.stats.maxDD,
          sharpe: r.stats.sharpe, params_json: p,
        }]);
      }
      setR2(false);
    }, 10);
  }

  const S = result?.stats;
  const SLIDERS = [
    { key: 'feeDragCents',  label: 'Fee Drag',           unit: 'c', min: 0, max: 15, step: 0.5, color: T.yellow },
    { key: 'minEdgeCents',  label: 'Min Edge to Enter',  unit: 'c', min: 0, max: 15, step: 0.5, color: T.green  },
    { key: 'daysToSimulate',label: 'Days to Simulate',   unit: 'd', min: 30, max: 365, step: 10, color: T.accent },
    { key: 'opPerDay',      label: 'Pairs Per Day',      unit: '',  min: 1, max: 10, step: 0.5, color: T.cyan   },
    { key: 'convergeDays',  label: 'Avg Convergence',    unit: 'd', min: 1, max: 30, step: 1,   color: T.purple },
    { key: 'divMean',       label: 'Avg Divergence',     unit: 'c', min: 2, max: 20, step: 1,   color: T.accent },
  ];

  const suggestions = S ? [
    S.sharpe < 0.5    && { t:'warn', msg:`Sharpe ${S.sharpe} below 0.5 — try raising min edge to ${p.minEdgeCents+1}c` },
    S.sharpe > 2.5    && { t:'good', msg:`Sharpe ${S.sharpe} excellent — could lower min edge to capture more volume` },
    S.winRate < 0.40  && { t:'warn', msg:`Win rate ${(S.winRate*100).toFixed(0)}% — reduce convergence days or raise min edge` },
    S.maxDD > 20      && { t:'warn', msg:`Max drawdown ${S.maxDD}% — raise fee drag assumption to stress-test` },
    S.n < 5           && { t:'info', msg:'Too few trades for statistical significance — lower min edge or raise opPerDay' },
    S.sharpe>=1.5 && S.winRate>=0.5 && S.maxDD<15 && { t:'good', msg:'Parameters look healthy — all key metrics in range' },
  ].filter(Boolean) : [];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14,
        padding: 16, background: T.surface, borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 16 }}>
        {SLIDERS.map(s => (
          <Slider key={s.key} label={s.label} value={p[s.key]} min={s.min} max={s.max} step={s.step}
            unit={s.unit} color={s.color} onChange={v => param(s.key, v)} />
        ))}
      </div>
      <Btn onClick={run} disabled={running} variant="default">
        {running ? 'RUNNING...' : 'RUN BACKTEST'}
      </Btn>

      {S && (
        <div style={{ marginTop: 20 }}>
          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
            {[
              { k: 'TOTAL RETURN', v: `${S.totalReturn}%`, c: S.totalReturn>=0?T.green:T.red },
              { k: 'SHARPE',       v: S.sharpe, c: S.sharpe>=1.5?T.green:S.sharpe>=0.5?T.yellow:T.red },
              { k: 'WIN RATE',     v: `${(S.winRate*100).toFixed(0)}%`, c: S.winRate>=0.5?T.green:T.yellow },
              { k: 'PROFIT FACTOR',v: S.pf, c: S.pf>=1.5?T.green:S.pf>=1?T.yellow:T.red },
              { k: 'MAX DRAWDOWN', v: `${S.maxDD}%`, c: S.maxDD<10?T.green:S.maxDD<20?T.yellow:T.red },
              { k: 'TRADES',       v: S.n, c: T.text },
              { k: 'AVG HOLD',     v: `${S.avgHold}d`, c: T.subtext },
              { k: 'TOTAL P&L',   v: `$${S.totalPnl}`, c: S.totalPnl>=0?T.green:T.red },
            ].map(s => (
              <div key={s.k} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: '12px 14px' }}>
                <KV k={s.k} v={s.v} vColor={s.c} />
              </div>
            ))}
          </div>

          {/* Equity curve */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: '12px 16px', marginBottom: 12 }}>
            <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, marginBottom: 8 }}>EQUITY CURVE</div>
            <EquityCurve equity={result.equity} />
          </div>

          {/* Suggestions */}
          {suggestions.length > 0 && (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 9, color: T.subtext, fontFamily: T.mono, letterSpacing: '0.1em', marginBottom: 8 }}>
                SELF-TUNING SUGGESTIONS
              </div>
              {suggestions.map((s, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: T.mono, marginBottom: 4,
                  color: s.t==='good' ? T.green : s.t==='warn' ? T.yellow : T.subtext }}>
                  {s.t==='good' ? '+ ' : s.t==='warn' ? '! ' : '- '}{s.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function ArbTab({ supabase }) {
  const [sub, setSub] = useState('scanner');
  const SUBS = [
    { id: 'scanner', label: 'Live Scanner' },
    { id: 'paper',   label: 'Paper Trader' },
    { id: 'backtest',label: 'Backtester'   },
  ];

  return (
    <div style={{ background: T.bg, minHeight: '100%', padding: '20px 24px', color: T.text, fontFamily: T.sans }}>
      <style>{`
        input[type=range]{-webkit-appearance:none;height:3px;background:${T.muted};border-radius:2px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;cursor:pointer}
      `}</style>

      {/* Tab header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: T.accent, letterSpacing: '-0.02em' }}>
            Prediction Market Arb
          </div>
          <div style={{ fontSize: 11, color: T.subtext }}>Kalshi &times; Polymarket mispricing scanner</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 0, background: T.surface,
          borderRadius: 6, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
          {SUBS.map(s => (
            <button key={s.id} onClick={() => setSub(s.id)} style={{
              padding: '7px 18px', fontSize: 11, cursor: 'pointer', fontFamily: T.mono,
              background: sub === s.id ? `${T.accent}18` : 'transparent',
              border: 'none', borderRight: `1px solid ${T.border}`,
              color: sub === s.id ? T.accent : T.subtext,
              borderBottom: sub === s.id ? `2px solid ${T.accent}` : '2px solid transparent',
            }}>{s.label.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {sub === 'scanner'  && <Scanner     supabase={supabase} />}
      {sub === 'paper'    && <PaperTrader supabase={supabase} />}
      {sub === 'backtest' && <Backtester  supabase={supabase} />}
    </div>
  );
}

export default ArbTab;
