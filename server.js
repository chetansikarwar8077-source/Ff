const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX = parseInt(process.env.MAX_SLOTS || '12', 10);      // kitni teams ka lobby
const PASS = process.env.ADMIN_PASSWORD || 'changeme';          // admin password (zaroor badlo)
const HOOK = process.env.DISCORD_WEBHOOK || '';                 // optional: Discord notification
const LOOKUP_URL = process.env.LOOKUP_URL || '';               // e.g. https://your-lookup/check?game=freefire&id={uid}
const LOOKUP_FIELD = process.env.LOOKUP_FIELD || 'nickname';   // response mein name ka path, e.g. data.nickname
const LOOKUP_REQUIRED = process.env.LOOKUP_REQUIRED === '1';   // 1 = verified name ke bina register nahi
const FILE = path.join(__dirname, 'data.json');

let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const clean = (s, n) => String(s || '').trim().slice(0, n);

const nameCache = new Map();
async function lookupName(uid) {
  if (!LOOKUP_URL) return null;
  const c = nameCache.get(uid);
  if (c && Date.now() - c.t < 600e3) return c.name;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(LOOKUP_URL.replace('{uid}', encodeURIComponent(uid)), { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    let name = LOOKUP_FIELD.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
    if (typeof name !== 'string' || !name.trim()) return null;
    name = name.trim().slice(0, 30);
    nameCache.set(uid, { name, t: Date.now() });
    return name;
  } catch (e) { return null; } finally { clearTimeout(to); }
}

const app = express();
app.use(express.json({ limit: '20kb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// simple rate limit: 10 registrations per IP per hour
const hits = new Map();
function limited(ip, max = 10) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

app.get('/api/stats', (req, res) => {
  res.json({ total: db.length, max: MAX, left: Math.max(0, MAX - db.length) });
});

app.get('/api/lookup', async (req, res) => {
  if (!LOOKUP_URL) return res.json({ ok: false, disabled: true });
  const uid = clean(req.query.uid, 14);
  if (!/^\d{6,14}$/.test(uid)) return res.status(400).json({ ok: false });
  if (limited('l' + req.ip, 30)) return res.status(429).json({ ok: false });
  const name = await lookupName(uid);
  res.json(name ? { ok: true, name } : { ok: false });
});

app.post('/api/register', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Bahut zyada try. Baad mein aao.' });
  const r = {
    team: clean(req.body.team, 30), leader: clean(req.body.leader, 30),
    uid: clean(req.body.uid, 14), phone: clean(req.body.phone, 15),
    others: clean(req.body.others, 300)
  };
  let verified = false;
  if (/^\d{6,14}$/.test(r.uid)) {
    const n = await lookupName(r.uid);
    if (n) { r.leader = n; verified = true; }          // server-side verified name
    else if (LOOKUP_REQUIRED && LOOKUP_URL)
      return res.status(422).json({ error: 'UID verify nahi hua. UID check karke dobara try karo.' });
  }
  r.verified = verified;
  if (!r.team || !r.leader || !/^\d{6,14}$/.test(r.uid) || !/^[\d+\s-]{8,15}$/.test(r.phone))
    return res.status(400).json({ error: 'Team, leader, sahi UID (digits) aur WhatsApp number bharo.' });
  if (db.some(x => x.uid === r.uid))
    return res.status(409).json({ error: 'Is UID se pehle hi registration ho chuka hai.' });

  r.slot = db.length + 1;            // registration order = slot number
  r.createdAt = new Date().toISOString();
  db.push(r); save();

  if (HOOK) fetch(HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `🔥 New: #${r.slot} ${r.team} | ${r.leader} | UID ${r.uid} | ${r.phone}` })
  }).catch(() => {});

  res.json({ slot: r.slot, team: r.team, waitlist: r.slot > MAX });
});

app.get('/api/slot', (req, res) => {
  const r = db.find(x => x.uid === clean(req.query.uid, 14));
  if (!r) return res.status(404).json({ error: 'Is UID se koi registration nahi mila.' });
  res.json({ slot: r.slot, team: r.team, waitlist: r.slot > MAX });
});

app.get('/api/admin', (req, res) => {
  if (req.get('x-admin-password') !== PASS) return res.status(401).json({ error: 'Galat password' });
  res.json({ max: MAX, registrations: db });
});

app.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
