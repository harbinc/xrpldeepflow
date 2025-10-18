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

// ---- ENV
const PORT = process.env.PORT || 8080;
const MIN_XRP = parseInt(process.env.MIN_XRP || '1000000', 10);
const XRPSCAN_SEARCH_URL =
  process.env.XRPSCAN_SEARCH_URL || 'https://console.xrpscan.com/api/v1/search';
const XRPSCAN_WELL_KNOWN =
  process.env.XRPSCAN_WELL_KNOWN || 'https://api.xrpscan.com/api/v1/names/well-known';
const PRICE_API =
  process.env.PRICE_API || 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';

// ---- CACHE
const cache = new Map();
const setCache = (k, v, ttlMs = 30_000) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => {
  const it = cache.get(k);
  return it && it.exp > Date.now() ? it.v : null;
};

// ---- FETCH HELPERS ----------------------------------------------------------
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonSafe(url, opts = {}, { timeoutMs = 15000, retries = 2, backoffMs = 400 } = {}) {
  // AbortController timeout
  const attempt = async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const ctype = (res.headers.get('content-type') || '').toLowerCase();

      // If status not OK, read text (if any) and throw
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${msg.slice(0, 200)}`);
      }

      // Content-type check; sometimes upstream returns text/empty on errors
      if (ctype.includes('application/json')) {
        return await res.json();
      } else {
        // try JSON parse as a fallback; if that fails, treat as empty
        const txt = await res.text();
        try { return JSON.parse(txt); } catch {
          throw new Error(`Non-JSON response (${ctype || 'no ctype'}): ${txt.slice(0, 200)}`);
        }
      }
    } finally {
      clearTimeout(t);
    }
  };

  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (e) {
      err = e;
      console.warn(`[fetchJsonSafe] attempt ${i + 1} failed:`, String(e).slice(0, 180));
      if (i < retries) await delay(backoffMs * (i + 1));
    }
  }
  // As a last resort return null; callers decide default
  return null;
}

// ---- XRPSCAN NORMALIZATION --------------------------------------------------
function extractRecords(j) {
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
  const j = await fetchJsonSafe(XRPSCAN_WELL_KNOWN, {}, { timeoutMs: 15000, retries: 2 });
  const dict = {};
  if (Array.isArray(j)) {
    for (const x of j) dict[x.address] = x; // {address,label,category}
  }
  setCache(ck, dict, 10 * 60 * 1000);
  return dict;
}

async function getXrpPrice() {
  const ck = 'xrp-usd';
  const c = getCache(ck);
  if (c) return c;
  const j = await fetchJsonSafe(PRICE_API, {}, { timeoutMs: 10000, retries: 1 });
  const usd = j?.ripple?.usd ?? 0.5;
  setCache(ck, usd, 30_000);
  return usd;
}

// ---- CLASSIFY + SCORE -------------------------------------------------------
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

// ---- DEDUPE HELPERS ---------------------------------------------------------
function makeKey(row) {
  return row.hash || `${row.from}|${row.to}|${row.amount_xrp}|${row.ledger_index || ''}|${new Date(row.ts).getTime()}`;
}
function dedupe(items) {
  const byKey = new Map();
  for (const it of items) {
    const k = makeKey(it);
    const prev = byKey.get(k);
    if (
      !prev ||
      (Number(it.amount_xrp) > Number(prev.amount_xrp)) ||
      (!!it.fromLabel && !prev.fromLabel) ||
      (!!it.toLabel && !prev.toLabel) ||
      (new Date(it.ts) > new Date(prev.ts))
    ) {
      byKey.set(k, it);
    }
  }
  return Array.from(byKey.values());
}

// ---- CORE FETCH -------------------------------------------------------------
async function fetchTopFlows({ sinceMinutes = 60, minXrp = MIN_XRP }) {
  // Body is intentionally permissive for XRPSCAN’s ES-like syntax variants
  const body = {
    size: 200,
    bool: {
      must: [{ term: { TransactionType: 'Payment' } }],
      filter: [
        { range: { 'Amount._value': { gte: minXrp } } },
        { range: { _date: { gte: `now-${sinceMinutes}m` } } }
      ]
    }
  };

  const j = await fetchJsonSafe(
    XRPSCAN_SEARCH_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    },
    { timeoutMs: 15000, retries: 2, backoffMs: 500 }
  );

  if (!j) {
    console.warn('XRPSCAN search returned null / non-JSON');
    return [];
  }

  const recs = extractRecords(j);
  if (!Array.isArray(recs) || recs.length === 0) {
    console.warn('XRPSCAN search empty/unexpected shape');
    return [];
  }

  const known = await getWellKnown();
  const xrpUsd = await getXrpPrice();

  const items = recs
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

  const unique = dedupe(items);
  unique.sort(
    (a, b) =>
      (b.score - a.score) ||
      (b.amount_xrp - a.amount_xrp) ||
      (new Date(b.ts) - new Date(a.ts))
  );
  return unique;
}

// ---- ROUTES -----------------------------------------------------------------
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
    res.json([]); // never 500
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
    res.json([]); // never 500
  }
});

// Simple status for troubleshooting
app.get('/api/status', async (_req, res) => {
  const price = await getXrpPrice();
  const known = await getWellKnown();
  res.json({
    ok: true,
    price_usd: price,
    well_known_count: Object.keys(known).length,
    search_url: XRPSCAN_SEARCH_URL
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Static SPA
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`XRPL DeepFlow running on http://0.0.0.0:${PORT}`)
);
