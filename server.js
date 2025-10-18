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

// Render/Heroku/etc. provide PORT
const PORT = process.env.PORT || 8080;
const MIN_XRP = parseInt(process.env.MIN_XRP || '1000000', 10); // default ≥ 1M XRP
const XRPSCAN_SEARCH_URL = process.env.XRPSCAN_SEARCH_URL || 'https://console.xrpscan.com/api/v1/search';
const XRPSCAN_WELL_KNOWN = process.env.XRPSCAN_WELL_KNOWN || 'https://api.xrpscan.com/api/v1/names/well-known';
const PRICE_API = process.env.PRICE_API || 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';

// ------------------------------------------------------------------
// Tiny cache
const cache = new Map();
const setCache = (k, v, ttlMs = 30_000) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => {
  const it = cache.get(k);
  return it && it.exp > Date.now() ? it.v : null;
};

// Helper: fetch with timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Normalize XRPSCAN responses that may change shape
function extractRecords(j) {
  // Accept common variations: [], {hits: []}, {hits:{hits:[]}}, {results:[]}, {data:[]}
  if (Array.isArray(j)) return j;
  if (Array.isArray(j?.hits)) return j.hits;
  if (Array.isArray(j?.hits?.hits)) return j.hits.hits;
  if (Array.isArray(j?.results)) return j.results;
  if (Array.isArray(j?.data)) return j.data;
  return [];
}
function getField(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

async function getWellKnown() {
  const ck = 'well-known';
  const c = getCache(ck);
  if (c) return c;
  try {
    const r = await fetchWithTimeout(XRPSCAN_WELL_KNOWN, {}, 15000);
    const arr = await r.json();
    const dict = {};
    for (const x of arr) dict[x.address] = x; // {address,label,category}
    setCache(ck, dict, 10 * 60 * 1000);
    return dict;
  } catch (e) {
    console.error('well-known fetch error', e);
    return {}; // degrade gracefully
  }
}

async function getXrpPrice() {
  const ck = 'xrp-usd';
  const c = getCache(ck);
  if (c) return c;
  try {
    const r = await fetchWithTimeout(PRICE_API, {}, 10000);
    const j = await r.json();
    const usd = j?.ripple?.usd || 0.5;
    setCache(ck, usd, 30_000);
    return usd;
  } catch (e) {
    console.error('price fetch error', e);
    return 0.5;
  }
}

function classifyDirection(sender, receiver, known) {
  const sKnown = !!known[sender];
  const rKnown = !!known[receiver];
  if (rKnown && known[receiver].category === 'exchange') return 'to_exchange';
  if (sKnown && known[sender].category === 'exchange') return 'from_exchange';
  if ((sKnown && /ripple/i.test(known[sender].label || '')) || (rKnown && /ripple/i.test(known[receiver].label || '')))
    return 'treasury';
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

// ------------------------------------------------------------------
// Robust search that soft-fails to []
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

  let j;
  try {
    const r = await fetchWithTimeout(
      XRPSCAN_SEARCH_URL,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      15000
    );
    j = await r.json();
  } catch (e) {
    console.error('XRPSCAN search fetch error:', e);
    return [];
  }

  const records = extractRecords(j);
  if (!Array.isArray(records) || records.length === 0) {
    console.warn('XRPSCAN search unexpected shape / empty:', JSON.stringify(j).slice(0, 400));
    return [];
  }

  const known = await getWellKnown();
  const xrpUsd = await getXrpPrice();

  const items = records
    .map((h) => {
      const s = h?._source ?? h?.source ?? h;

      const amtRaw = getField(s, 'Amount', 'amount', 'value');
      const amtXrp = typeof amtRaw === 'object'
        ? Number(amtRaw?._value ?? 0)
        : Number(amtRaw ?? 0);

      const hash = getField(s, 'hash', 'tx', 'tx_hash', 'id') || '';
      const ts   = getField(s, '_date', 'date', 'timestamp') || new Date().toISOString();
      const from = getField(s, 'Account', 'from', 'source', 'sender') || '';
      const to   = getField(s, 'Destination', 'to', 'destination', 'receiver') || '';

      const dir = classifyDirection(from, to, known);
      const score = scoreEvent(amtXrp, dir, from, to, known);

      return {
        hash,
        ledger_index: getField(s, 'ledger_index', 'ledgerIndex') ?? null,
        ts,
        from,
        to,
        fromLabel: known[from]?.label || null,
        toLabel: known[to]?.label || null,
        amount_xrp: amtXrp,
        amount_usd: Math.round(amtXrp * xrpUsd),
        direction: dir,
        score
      };
    })
    .filter((row) => Number.isFinite(row.amount_xrp) && row.amount_xrp >= (minXrp || 0));

  items.sort(
    (a, b) =>
      (b.score - a.score) ||
      (b.amount_xrp - a.amount_xrp) ||
      (new Date(b.ts) - new Date(a.ts))
  );

  return items;
}

// ------------------------------------------------------------------
// Routes (soft-fail to [] so UI stays up)
app.get('/api/top-flows', async (req, res) => {
  try {
    const since = Math.min(24 * 60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = parseInt(req.query.minXrp || String(MIN_XRP), 10);
    const cacheKey = `top:${since}:${min}`;
    const c = getCache(cacheKey);
    if (c) return res.json(c);
    const data = await fetchTopFlows({ sinceMinutes: since, minXrp: min });
    setCache(cacheKey, data);
    res.json(data);
  } catch (e) {
    console.error('/api/top-flows error', e);
    res.json([]); // <= no 500
  }
});

app.get('/api/exchange-heatmap', async (req, res) => {
  try {
    const since = Math.min(24 * 60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = parseInt(req.query.minXrp || String(MIN_XRP), 10);
    const flows = await fetchTopFlows({ sinceMinutes: since, minXrp: min });

    const heat = {};
    for (const f of flows) {
      const venue =
        f.direction === 'to_exchange'
          ? (f.toLabel || 'Exchange')
          : f.direction === 'from_exchange'
            ? (f.fromLabel || 'Exchange')
            : null;
      if (!venue) continue;
      const key = venue.replace(/\s+Hot.*/i, '');
      heat[key] = heat[key] || 0;
      heat[key] += (f.direction === 'to_exchange' ? +1 : -1) * (f.amount_xrp / 1e6);
    }
    const arr = Object.entries(heat)
      .map(([venue, net]) => ({ venue, net: Math.round(net * 10) / 10 }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    res.json(arr);
  } catch (e) {
    console.error('/api/exchange-heatmap error', e);
    res.json([]); // <= no 500
  }
});

// Health check for Render/uptime
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Static SPA
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`XRPL DeepFlow running on http://0.0.0.0:${PORT}`)
);
