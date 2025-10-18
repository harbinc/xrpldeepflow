import express from 'express';
import fetch from 'node-fetch';
import morgan from 'morgan';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import xrpl from 'xrpl';

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
  process.env.XRPSCAN_SEARCH_URL || 'https://console.xrpscan.com/api/v1/search'; // may 500
const XRPSCAN_WELL_KNOWN =
  process.env.XRPSCAN_WELL_KNOWN || 'https://api.xrpscan.com/api/v1/names/well-known';
const PRICE_API =
  process.env.PRICE_API || 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';
const XRPL_WS_URL =
  process.env.XRPL_WS_URL || 'wss://xrplcluster.com'; // public cluster; see xrpl.org "Public Servers"

// ---- CACHE
const cache = new Map();
const setCache = (k, v, ttlMs = 30_000) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => {
  const it = cache.get(k);
  return it && it.exp > Date.now() ? it.v : null;
};

// ---- FETCH HELPERS ----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonSafe(url, opts = {}, { timeoutMs = 15000, retries = 2, backoffMs = 400 } = {}) {
  const attempt = async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${msg.slice(0, 200)}`);
      }
      if (ctype.includes('application/json')) return res.json();
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { throw new Error(`Non-JSON: ${ctype || 'unknown'}`); }
    } finally {
      clearTimeout(t);
    }
  };

  let err;
  for (let i = 0; i <= retries; i++) {
    try { return await attempt(); }
    catch (e) {
      err = e;
      console.warn(`[fetchJsonSafe] attempt ${i + 1} failed:`, String(e).slice(0, 180));
      if (i < retries) await sleep(backoffMs * (i + 1));
    }
  }
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
  if (Array.isArray(j)) for (const x of j) dict[x.address] = x; // {address,label,category}
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

// ---- DEDUPE -----------------------------------------------------------------
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

// ---- XRPL LIVE FALLBACK (WebSocket) ----------------------------------------
// Keep a rolling buffer of recent large Payment tx from the network.
const liveBuffer = [];
const MAX_BUFFER = 1000; // ~recent few minutes, depending on threshold
let xrplClient = null;

async function startXRPLStream() {
  try {
    xrplClient = new xrpl.Client(XRPL_WS_URL, { connectionTimeout: 15000 });
    await xrplClient.connect();

    // Subscribe to validated transactions stream
    await xrplClient.request({ command: 'subscribe', streams: ['transactions'] });

    xrplClient.on('transaction', async (msg) => {
      try {
        const tx = msg?.transaction;
        const meta = msg?.meta;
        if (!tx || tx.TransactionType !== 'Payment') return;

        // Only XRP (Amount is string drops for XRP; object means IOU)
        if (typeof tx.Amount !== 'string') return;

        const drops = Number(tx.Amount);
        const xrp = drops / 1_000_000;
        if (!Number.isFinite(xrp) || xrp < (MIN_XRP / 1_000_000)) return;

        const known = await getWellKnown();
        const xrpUsd = await getXrpPrice();

        const from = tx.Account;
        const to = tx.Destination;
        const hash = msg?.transaction?.hash || msg?.hash || '';
        const ts = msg?.validated ? new Date().toISOString() : new Date().toISOString(); // approximate; ledger close time available if you also subscribe to 'ledger'

        const direction = classifyDirection(from, to, known);
        const score = scoreEvent(xrp, direction, from, to, known);

        const row = {
          hash,
          ledger_index: msg?.ledger_index ?? null,
          ts,
          from,
          to,
          fromLabel: known[from]?.label || null,
          toLabel: known[to]?.label || null,
          amount_xrp: xrp,
          amount_usd: Math.round(xrp * xrpUsd),
          direction,
          score
        };

        // push + dedupe ring buffer
        liveBuffer.push(row);
        if (liveBuffer.length > MAX_BUFFER) liveBuffer.splice(0, liveBuffer.length - MAX_BUFFER);
      } catch (e) {
        console.warn('stream parse err', e);
      }
    });

    xrplClient.on('disconnected', () => console.warn('XRPL WS disconnected'));
    console.log(`XRPL WebSocket connected: ${XRPL_WS_URL}`);
  } catch (e) {
    console.error('XRPL WS connect error', e);
    // Retry later
    setTimeout(() => startXRPLStream().catch(()=>{}), 5000);
  }
}
startXRPLStream(); // fire and forget

// ---- CORE FETCH (XRPSCAN primary) ------------------------------------------
async function fetchTopFlowsXRPSCAN({ sinceMinutes = 60, minXrp = MIN_XRP }) {
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
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { timeoutMs: 15000, retries: 2, backoffMs: 500 }
  );
  if (!j) return [];

  const recs = extractRecords(j);
  if (!Array.isArray(recs) || recs.length === 0) return [];

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
  unique.sort((a,b)=> (b.score - a.score) || (b.amount_xrp - a.amount_xrp) || (new Date(b.ts) - new Date(a.ts)));
  return unique;
}

// Composite: try XRPSCAN, else live buffer
async function fetchTopFlows({ sinceMinutes = 60, minXrp = MIN_XRP }) {
  const primary = await fetchTopFlowsXRPSCAN({ sinceMinutes, minXrp });
  if (primary.length > 0) return primary;

  // Fallback: filter the live buffer by min amount + time window
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;
  const items = liveBuffer
    .filter(r => r.amount_xrp >= (minXrp / 1_000_000) && new Date(r.ts).getTime() >= sinceMs);
  const unique = dedupe(items);
  unique.sort((a,b)=> (b.score - a.score) || (b.amount_xrp - a.amount_xrp) || (new Date(b.ts) - new Date(a.ts)));
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

app.get('/api/status', async (_req, res) => {
  const price = await getXrpPrice();
  const known = await getWellKnown();
  res.json({
    ok: true,
    price_usd: price,
    well_known_count: Object.keys(known).length,
    search_url: XRPSCAN_SEARCH_URL,
    ws_url: XRPL_WS_URL,
    live_buffer_size: liveBuffer.length
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Static SPA
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`XRPL DeepFlow running on http://0.0.0.0:${PORT}`)
);
