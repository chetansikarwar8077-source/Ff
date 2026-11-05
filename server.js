const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX = parseInt(process.env.MAX_SLOTS || '12', 10);        // kitni teams ka lobby
const PASS = process.env.ADMIN_PASSWORD || 'changeme';           // admin password (zaroor badlo)
const HOOK = process.env.DISCORD_WEBHOOK || '';                  // optional Discord notification
const LOOKUP_URL = process.env.LOOKUP_URL || '';                 // .../api/v1/info?region={region}&uid={uid}
const LOOKUP_FIELD = process.env.LOOKUP_FIELD || 'basicInfo.nickname';
const LOOKUP_API_KEY = process.env.LOOKUP_API_KEY || '';         // x-api-key (sirf Render env mein rakho)
const LOOKUP_REGION = process.env.LOOKUP_REGION || 'ind';
const LOOKUP_REQUIRED = process.env.LOOKUP_REQUIRED === '1';     // 1 = verified naam ke bina registration nahi
const FILE = path.join(__dirname, 'data.json');

let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cleanRegion = r => (/^[a-z]{2,4}$/i.test(String(r || '')) ? String(r).toLowerCase() : LOOKUP_REGION);
const isUid = u => /^\d{6,14}$/.test(u);

const nameCache = new Map();
async function lookupName(uid, region) {
  if (!LOOKUP_URL || !isUid(uid)) return null;
  const ck = region + ':' + uid;
  const c = nameCache.get(ck);
  if (c && Date.now() - c.t < 600e3) return c.name;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const headers = { 'User-Agent': 'FFTournamentSite/1.0 (registration website)', 'Accept': 'application/json' };
    if (LOOKUP_API_KEY) headers['x-api-key'] = LOOKUP_API_KEY;
    const url = LOOKUP_URL.replace('{uid}', encodeURIComponent(uid)).replace('{region}', encodeURIComponent(region)).replace('{REGION}', encodeURIComponent(region.toUpperCase()));
    const r = await fetch(url, { signal: ctl.signal, headers });
    if (!r.ok) return null;
    const j = await r.json();
    const find = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 5) return null;
      for (const k of Object.keys(o)) if (/^(nick_?name|name)$/i.test(k) && typeof o[k] === 'string' && o[k].trim()) return o[k];
      for (const k of Object.keys(o)) { const v = find(o[k], d + 1); if (v) return v; }
      return null;
    };
    let name = LOOKUP_FIELD ? LOOKUP_FIELD.split('.').reduce((o, k) => (o == null ? o : o[k]), j) : find(j);
    if (typeof name !== 'string' || !name.trim()) return null;
    name = name.trim().slice(0, 30);
    nameCache.set(ck, { name, t: Date.now() });
    return name;
  } catch (e) { return null; } finally { clearTimeout(to); }
}

const app = express();
app.use(express.json({ limit: '20kb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const hits = new Map();
function limited(key, max) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < 3600e3);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}

app.get('/api/stats', (req, res) => {
  res.json({ total: db.length, max: MAX, left: Math.max(0, MAX - db.length) });
});

app.get('/api/lookup', async (req, res) => {
  if (!LOOKUP_URL) return res.json({ ok: false, disabled: true });
  const uid = clean(req.query.uid, 14);
  if (!isUid(uid)) return res.status(400).json({ ok: false });
  if (limited('l' + req.ip, 60)) return res.status(429).json({ ok: false });
  const name = await lookupName(uid, cleanRegion(req.query.region));
  res.json(name ? { ok: true, name } : { ok: false });
});

app.post('/api/register', async (req, res) => {
  if (limited('r' + req.ip, 10)) return res.status(429).json({ error: 'Bahut zyada try. Baad mein aao.' });
  const b = req.body || {};
  const region = cleanRegion(b.region);
  const team = clean(b.team, 30), phone = clean(b.phone, 15), uid = clean(b.uid, 14);
  const rawMates = (Array.isArray(b.mates) ? b.mates : []).slice(0, 4)
    .map(m => ({ uid: clean(m && m.uid, 14), name: clean(m && m.name, 30) }));
  const mates = rawMates.filter((m, i) => i < 3 || m.uid);   // 4th (substitute) optional

  if (!team || !isUid(uid) || !/^[\d+\s-]{8,15}$/.test(phone))
    return res.status(400).json({ error: 'Team name, leader UID aur WhatsApp number sahi bharo.' });
  if (mates.length < 3 || mates.some(m => !isUid(m.uid)))
    return res.status(400).json({ error: 'Kam se kam 3 teammates ka sahi UID bharo.' });
  const all = [uid, ...mates.map(m => m.uid)];
  if (new Set(all).size !== all.length)
    return res.status(400).json({ error: 'Ek hi UID do baar daala hai.' });

  // server par naam dobara verify
  const names = await Promise.all(all.map(u => lookupName(u, region)));
  if (LOOKUP_REQUIRED && LOOKUP_URL && names.some(n => !n))
    return res.status(422).json({ error: 'Kisi UID ka naam verify nahi hua. UID check karke dobara try karo.' });
  const leaderName = names[0] || clean(b.leaderName, 30);
  mates.forEach((m, i) => { if (names[i + 1]) m.name = names[i + 1]; m.verified = !!names[i + 1]; });
  if (!leaderName || mates.some(m => !m.name))
    return res.status(400).json({ error: 'Sabhi players ke naam chahiye.' });

  // duplicate check (lookup ke baad, taaki slot sahi mile)
  const taken = new Set(); db.forEach(x => { taken.add(x.uid); (x.mates || []).forEach(m => taken.add(m.uid)); });
  const dup = all.find(u => taken.has(u));
  if (dup) return res.status(409).json({ error: 'UID ' + dup + ' pehle hi registered hai.' });

  const r = { team, leader: leaderName, uid, verified: !!names[0], phone, region, mates,
              slot: db.length + 1, createdAt: new Date().toISOString() };
  db.push(r); save();

  if (HOOK) fetch(HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `🔥 New: #${r.slot} ${r.team} | Leader ${r.leader} (${r.uid}) | ${r.phone} | Mates: ` +
      mates.map(m => m.name + ' (' + m.uid + ')').join(', ') })
  }).catch(() => {});

  res.json({ slot: r.slot, team: r.team, waitlist: r.slot > MAX });
});

app.get('/api/slot', (req, res) => {
  const u = clean(req.query.uid, 14);
  const r = db.find(x => x.uid === u || (x.mates || []).some(m => m.uid === u));
  if (!r) return res.status(404).json({ error: 'Is UID se koi registration nahi mila.' });
  res.json({ slot: r.slot, team: r.team, waitlist: r.slot > MAX });
});

app.get('/api/admin', (req, res) => {
  if (req.get('x-admin-password') !== PASS) return res.status(401).json({ error: 'Galat password' });
  res.json({ max: MAX, registrations: db });
});

app.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
