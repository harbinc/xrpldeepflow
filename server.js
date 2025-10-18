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

// ---------------- ENV ----------------
const PORT = process.env.PORT || 8080;

// IMPORTANT: Treat MIN_XRP as **XRP units** (not drops).
// Default: 1,000,000 XRP (i.e., 1 million XRP)
const MIN_XRP = Number(process.env.MIN_XRP || 1_000_000);

// Upstream sources
const XRPSCAN_SEARCH_URL =
  process.env.XRPSCAN_SEARCH_URL || 'https://console.xrpscan.com/api/v1/search';
const XRPSCAN_WELL_KNOWN =
  process.env.XRPSCAN_WELL_KNOWN || 'https://api.xrpscan.com/api/v1/names/well-known';
const PRICE_API =
  process.env.PRICE_API || 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd';
const XRPL_WS_URL =
  process.env.XRPL_WS_URL || 'wss://xrplcluster.com';

// ---------------- CACHE ----------------
const cache = new Map();
const setCache = (k, v, ttlMs = 30_000) => cache.set(k, { v, exp: Date.now() + ttlMs });
const getCache = (k) => {
  const it = cache.get(k);
  return it && it.exp > Date.now() ? it.v : null;
};

// ---------------- HELPERS ----------------
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
      try { return JSON.parse(txt); } catch { throw new Error(`Non-JSON (${ctype || 'unknown'})`); }
    } finally {
      clearTimeout(t);
    }
  };
  for (let i = 0; i <= retries; i++) {
    try { return await attempt(); }
    catch (e) {
      if (i === retries) return null;
      await sleep(backoffMs * (i + 1));
    }
  }
  return null;
}

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
  if (Array.isArray(j)) for (const x of j) dict[x.address] = x;
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

// ---------------- XRPL LIVE FALLBACK ----------------
const liveBuffer = [];
const MAX_BUFFER = 1000;
let liveConnected = false;
let xrplClient = null;

async function startXRPLStream() {
  try {
    xrplClient = new xrpl.Client(XRPL_WS_URL, { connectionTimeout: 15000 });
    await xrplClient.connect();
    await xrplClient.request({ command: 'subscribe', streams: ['transactions'] });
    liveConnected = true;
    console.log(`XRPL WebSocket connected: ${XRPL_WS_URL}`);

    xrplClient.on('transaction', async (msg) => {
      try {
        if (!msg.validated) return; // only validated tx to avoid noise
        const tx = msg?.transaction;
        if (!tx || tx.TransactionType !== 'Payment') return;

        // Only XRP, not IOUs: XRP Amount is a string (drops)
        if (typeof tx.Amount !== 'string') return;

        const drops = Number(tx.Amount);
        const xrp = drops / 1_000_000;
        // MIN_XRP is in XRP; compare directly
        if (!Number.isFinite(xrp) || xrp < MIN_XRP) return;

        const [known, xrpUsd] = await Promise.all([getWellKnown(), getXrpPrice()]);
        const from = tx.Account;
        const to = tx.Destination;
        const hash = tx.hash || msg?.hash || '';
        const ts = new Date().toISOString();

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

        liveBuffer.push(row);
        if (liveBuffer.length > MAX_BUFFER) liveBuffer.splice(0, liveBuffer.length - MAX_BUFFER);
      } catch (_) {}
    });

    xrplClient.on('disconnected', () => { liveConnected = false; console.warn('XRPL WS disconnected'); });
  } catch (e) {
    liveConnected = false;
    console.error('XRPL WS connect error', e?.message || e);
    setTimeout(() => startXRPLStream().catch(()=>{}), 5000);
  }
}
startXRPLStream();

// ---------------- XRPSCAN PRIMARY ----------------
// IMPORTANT: XRPSCAN stores Amount in **drops**; convert our XRP threshold to drops.
async function fetchTopFlowsXRPSCAN({ sinceMinutes = 60, minXrp = MIN_XRP }) {
  const minDrops = Math.floor(minXrp * 1_000_000); // XRP -> drops

  const body = {
    size: 200,
    bool: {
      must: [{ term: { TransactionType: 'Payment' } }],
      filter: [
        { range: { 'Amount._value': { gte: minDrops } } },
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

  const [known, xrpUsd] = await Promise.all([getWellKnown(), getXrpPrice()]);

  const items = recs
    .map((h) => {
      const s = h?._source ?? h?.source ?? h;

      // Amount could be object {_value (drops)} or number-string (drops)
      const amtRaw = getField(s, 'Amount', 'amount', 'value');
      const drops =
        typeof amtRaw === 'object' ? Number(amtRaw?._value ?? 0) : Number(amtRaw ?? 0);
      const amtXrp = drops / 1_000_000;

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

// Composite: try XRPSCAN, fallback to live buffer (validated tx)
async function fetchTopFlows({ sinceMinutes = 60, minXrp = MIN_XRP }) {
  // Primary
  const primary = await fetchTopFlowsXRPSCAN({ sinceMinutes, minXrp });
  if (primary.length > 0) {
    setCache('lastSource', 'xrpscan', 30_000);
    return primary;
  }

  // Fallback (live)
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;
  const items = liveBuffer.filter(
    r => r.amount_xrp >= minXrp && new Date(r.ts).getTime() >= sinceMs
  );
  const unique = dedupe(items);
  unique.sort((a,b)=> (b.score - a.score) || (b.amount_xrp - a.amount_xrp) || (new Date(b.ts) - new Date(a.ts)));

  setCache('lastSource', 'live', 30_000);
  return unique;
}

// --------------- ROUTES ---------------
app.get('/api/top-flows', async (req, res) => {
  try {
    const since = Math.min(24 * 60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = Number(req.query.minXrp || MIN_XRP);

    // IMPORTANT: do not cache empty arrays — only cache when non-empty
    const cacheKey = `top:${since}:${min}`;
    const c = getCache(cacheKey);
    if (c && Array.isArray(c) && c.length) return res.json(c);

    const data = await fetchTopFlows({ sinceMinutes: since, minXrp: min });
    if (Array.isArray(data) && data.length) setCache(cacheKey, data, 20_000);
    res.json(data);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/exchange-heatmap', async (req, res) => {
  try {
    const since = Math.min(24 * 60, parseInt(req.query.sinceMinutes || '60', 10));
    const min = Number(req.query.minXrp || MIN_XRP);
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
    res.json([]);
  }
});

// Simple meta for UI/debug
app.get('/api/meta', (_req, res) => {
  const source = getCache('lastSource') || (liveConnected ? 'live' : 'unknown');
  res.json({
    ok: true,
    source,
    ws_connected: liveConnected,
    live_buffer: liveBuffer.length,
    min_xrp_threshold: MIN_XRP
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Static SPA
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`XRPL DeepFlow running on http://0.0.0.0:${PORT}`)
);
