// pages/api/save-auto-config.js
// Browser POSTs approved schedules here; we commit them to GitHub as
// public/auto-trade-config.json so the cron can read them server-side.
//
// Body: { schedules: [{symbol, scenario, side, bet}], githubToken: "ghp_..." }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { schedules, githubToken } = req.body || {};

  if (!Array.isArray(schedules)) {
    return res.status(400).json({ error: 'schedules must be an array' });
  }

  const token = githubToken || process.env.GITHUB_PAT;
  if (!token) {
    return res.status(400).json({ error: 'No GitHub token — pass githubToken in body or set GITHUB_PAT env var' });
  }

  const config = {
    updated: new Date().toISOString(),
    count:   schedules.length,
    schedules,
  };

  const content2 = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');

  const REPO_PATH = 'public/auto-trade-config.json';
  const API_URL   = `https://api.github.com/repos/justingoody28-jpg/apex-trader-sandbox/contents/${REPO_PATH}`;
  const GH_HEADERS = {
    Authorization:  `token ${token}`,
    'Content-Type': 'application/json',
    Accept:         'application/vnd.github.v3+json',
  };

  // Check if the file already exists (need its SHA to overwrite)
  let sha;
  try {
    const existing = await fetch(API_URL, { headers: GH_HEADERS });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }
  } catch (_) { /* file does not exist yet */ }

  const putBody = {
    message: `auto-trade: sync config (${schedules.length} schedules)`,
    content: content2,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(API_URL, {
    method:  'PUT',
    headers: GH_HEADERS,
    body:    JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    return res.status(500).json({ error: err.message || `GitHub write failed (${putRes.status})` });
  }

  return res.status(200).json({ ok: true, saved: schedules.length });
}