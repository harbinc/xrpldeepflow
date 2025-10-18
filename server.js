import express from 'express';
import fetch from 'node-fetch';
import morgan from 'morgan';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan('tiny'));
app.use(cors());
app.use(express.json());

// Render will set PORT; default to 8080 locally
const PORT = process.env.PORT || 8080;
const MIN_XRP = parseInt(process.env.MIN_XRP || '1000000', 10);
const XRPSCAN_SEARCH_URL = process.env.XRPSCAN_SEARCH_URL || 'https://console.xrpscan.com/api/v1/search';
const XRPSCAN_WELL_KNOWN = process.env.XRPSCAN_WELL_KNOWN || 'https://api.xrpscan.com/api/v1/names/well-known';
const PRICE_API = process.env.PRICE_API || 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';

// Lightweight cache (in-memory)
const cache = new Map();
const setCache = (k, v, ttlMs = 30_000) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => { const it = cache.get(k); return it && it.exp > Date.now() ? it.v : null; };

// Helper: fetch with timeout via AbortController
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function getWellKnown() {
  const ck = 'well-known';
  const c = getCache(ck);
  if (c) return c;
  const r = await fetchWithTimeout(XRPSCAN_WELL_KNOWN, {}, 15000);
  const data = await r.json();
  const dict = {};
  for (const x of data) dict[x.address] = x; // {address,label,category}
  setCache(ck, dict, 10 * 60 * 1000);
  return dict;
}

async function getXrpPrice() {
  const ck = 'xrp-usd';
  const c = getCache(ck);
  if (c) return c;
  const r = await fetchWithTimeout(PRICE_API, {}, 10000);
  const j = await r.json();
  const usd = j?.ripple?.usd || 0.5;
  setCache(ck, usd, 30_000);
  return usd;
}

function classifyDirection(sender, receiver, known) {
  const sKnown = !!known[sender];
  const rKnown = !!known[receiver];
  if (rKnown && known[receiver].category === 'exchange') return 'to_exchange';
  if (sKnown && known[sender].category === 'exchange') return 'from_exchange';
  if ((sKnown && /ripple/i.test(known[sender].label || '')) || (rKnown && /ripple/i.test(known[receiver].label || ''))) return 'treasury';
  return 'p2p';
}

function scoreEvent(amt, direction, sender, receiver, known) {
  const logSize = Math.min(60, Math.floor(10 * Math.log10(Math.max(amt, 1))));
  let ent = 0;
  for (const addr of [sender, receiver]) {
    if (known[addr] && ['exchange', 'custodian', 'ripple'].includes(known[addr].category)) ent += 10;
  }
  const dirb = direction === 'from_exchange' ? 15 : direction === 'to_exchange' ? 10 : direction === 'treasury' ? 12 : 0;
  return Math.min(100, logSize + ent + dirb);
}

async function fetchTopFlows({ sinceMinutes = 60, minXrp = MIN_XRP }) {
  const body = {
    bool: {
      must: [{ term: { TransactionType: 'Payment' } }],
      filter: [
        { range: { 'Amount._value': { gte: minXrp } } },
        { range: { _date: { gte: `now-${sinceMinutes}m` } } }
      ]
    }
  };
  const r = await fetchWithTimeout(
    XRPSCAN_SEARCH_URL,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    15000
  );
  const j = await r.json();
  const hits = j?.hits || [];
  const known = await getWellKnown();
  const xrpUsd = await getXrpPrice();
  const items = hits.map(h => {
    const s = h._source;
    const amtXrp = Number(s?.Amount?._value || 0);
    const dir = classifyDirection(s.Account, s.Destination, known);
    const score = scoreEvent(amtXrp, dir, s.Account, s.Destination, known);
    return {
      hash: s.hash,
      ledger_index: s.ledger_index,
      ts: s._date,
      from: s.Account,
      to: s.Destination,
      fromLabel: known[s.Account]?.label || null,
      toLabel: known[s.Destination]?.label || null,
      amount_xrp: amtXrp,
      amount_usd: Math.round(amtXrp * xrpUsd),
      direction: dir,
      score
    };
  });
  items.sort((a,b)=> (b.score - a.score) || (b.amount_xrp - a.amount_xrp) || (new Date(b.ts) - new Date(a.ts)) );
  return items;
}

app.get('/api/top-flows', async (req, res) => {
  try {
    const since = Math.min(24*60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = parseInt(req.query.minXrp || String(MIN_XRP), 10);
    const cacheKey = `top:${since}:${min}`;
    const c = getCache(cacheKey);
    if (c) return res.json(c);
    const data = await fetchTopFlows({ sinceMinutes: since, minXrp: min });
    setCache(cacheKey, data);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load top flows', detail: String(e) });
  }
});

app.get('/api/exchange-heatmap', async (req, res) => {
  try {
    const since = Math.min(24*60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = parseInt(req.query.minXrp || String(MIN_XRP), 10);
    const flows = await fetchTopFlows({ sinceMinutes: since, minXrp: min });
    const heat = {};
    for (const f of flows) {
      const venue = f.direction === 'to_exchange' ? (f.toLabel || 'Exchange') : f.direction === 'from_exchange' ? (f.fromLabel || 'Exchange') : null;
      if (!venue) continue;
      const key = venue.replace(/\s+Hot.*/i, '');
      heat[key] = heat[key] || 0;
      heat[key] += (f.direction === 'to_exchange' ? +1 : -1) * (f.amount_xrp / 1e6);
    }
    const arr = Object.entries(heat).map(([venue, net]) => ({ venue, net: Math.round(net * 10)/10 }));
    arr.sort((a,b)=> Math.abs(b.net) - Math.abs(a.net));
    res.json(arr);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load heatmap', detail: String(e) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => console.log(`XRPL DeepFlow running on http://0.0.0.0:${PORT}`));
