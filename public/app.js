// public/app.js

// Tiny DOM helper
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) el.append(c?.nodeType ? c : document.createTextNode(c));
  return el;
};

const fmt = new Intl.NumberFormat();
const state = {
  minXrp: 1_000_000,       // 1M XRP default (server expects XRP units)
  sinceMinutes: 180,       // last 3 hours
  timer: null
};

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    // All our endpoints return JSON arrays/objects
    return await r.json();
  } catch (e) {
    console.error('fetchJSON error:', url, e);
    return null; // caller handles null
  }
}

function directionChip(dir) {
  const map = {
    to_exchange: { text: '→ Exchange', cls: 'chip amber' },
    from_exchange: { text: '← Exchange', cls: 'chip green' },
    treasury: { text: 'Treasury/Escrow', cls: 'chip gray' },
    p2p: { text: 'P2P', cls: 'chip cyan' }
  };
  const d = map[dir] || map.p2p;
  return h('span', { class: d.cls, title: d.text }, d.text);
}

function scorePill(score) {
  const tone = score >= 80 ? 'pill green' : score >= 60 ? 'pill cyan' : 'pill neutral';
  const label = score >= 80 ? 'Institutional-grade' : score >= 60 ? 'High-likelihood' : 'Notable';
  return h('span', { class: tone, title: label }, `${label} · ${score}`);
}

function emptyRow(colspan, msg = 'No large flows detected for the selected window/threshold.') {
  return h('tr', {}, h('td', { class: 'muted', colspan: String(colspan) }, msg));
}

function buildHeader() {
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('div', { class: 'logo' }, 'X'),
      h('div', { class: 'brand-text' },
        h('div', { class: 'name' }, 'XRPL DeepFlow'),
        h('div', { class: 'tag' }, 'Institutional-Scale XRP Flow Monitor')
      )
    ),
    h('nav', { class: 'nav' },
      h('a', { href: '#flows' }, 'Top Flows'),
      h('a', { href: '#exchanges' }, 'Exchange Heat'),
      h('a', { href: '#alerts' }, 'Alerts')
    )
  );
}

function buildHero() {
  return h('section', { class: 'hero' },
    h('h1', {}, 'See ', h('span', { class: 'grad' }, 'Big Money'), ' Move on XRPL'),
    h('p', { class: 'muted' }, 'Real-time detection of large XRP transfers, exchange flows, and treasury events.'),
    h('div', { class: 'badges' },
      h('span', { class: 'badge white' }, 'Dark UI'),
      h('span', { class: 'badge cyan' }, 'XRPL-native'),
      h('span', { class: 'badge' }, 'Free to use')
    )
  );
}

function buildControls(onChange) {
  return h('div', { class: 'controls' },
    h('div', {}, 'Min Amount:'),
    h('select', {
      id: 'minFilter',
      onChange: (e) => {
        const m = Number(e.target.value) * 1_000_000; // value in millions → XRP units
        state.minXrp = m;
        onChange?.(m);
      }
    },
      h('option', { value: '1', selected: state.minXrp === 1_000_000 }, '≥ 1M XRP'),
      h('option', { value: '5', selected: state.minXrp === 5_000_000 }, '≥ 5M XRP'),
      h('option', { value: '10', selected: state.minXrp === 10_000_000 }, '≥ 10M XRP')
    )
  );
}

async function render() {
  const root = document.getElementById('app');
  root.innerHTML = '';

  // meta: tells us if we’re using XRPSCAN (primary) or live fallback
  const meta = await fetchJSON('/api/meta');
  if (meta?.source === 'live') {
    const bar = h('div', { style: { background: '#1f2937', color: '#e5e7eb', padding: '8px 12px', fontSize: '12px', textAlign: 'center' } },
      'Live mode: XRPSCAN is unavailable, streaming from XRPL public node.'
    );
    root.append(bar);
  }

  // static header + hero
  const header = buildHeader();
  const hero = buildHero();
  root.append(header, hero);

  // fetch data in parallel
  const query = `sinceMinutes=${encodeURIComponent(state.sinceMinutes)}&minXrp=${encodeURIComponent(state.minXrp)}`;
  const [flows, heat] = await Promise.all([
    fetchJSON(`/api/top-flows?${query}`),
    fetchJSON(`/api/exchange-heatmap?${query}`)
  ]);

  // Exchange Heat section
  const exchHead = h('div', { class: 'section-head' },
    h('h2', {}, 'Exchange Heat (24h)'),
    h('div', { class: 'muted tiny' }, 'Net inflow(+) / outflow(-) in millions of XRP')
  );

  const tiles = h('div', { class: 'tiles' });
  if (Array.isArray(heat) && heat.length) {
    for (const x of heat.slice(0, 5)) {
      tiles.append(
        h('div', { class: 'tile' },
          h('div', { class: 'muted small' }, x.venue),
          h('div', { class: x.net >= 0 ? 'num green' : 'num amber' }, `${x.net > 0 ? '+' : ''}${x.net}M`),
          h('div', { class: 'muted tiny' }, 'based on detected large flows')
        )
      );
    }
  } else {
    tiles.append(h('div', { class: 'muted small' }, 'No exchange heat yet.'));
  }
  const exchSection = h('section', { id: 'exchanges' }, exchHead, tiles);
  root.append(exchSection);

  // Top Flows section
  const flowsHead = h('div', { class: 'section-head' },
    h('h2', {}, "Today's Top Flows"),
    buildControls(async () => {
      // re-render table only (don’t rebuild whole page)
      const newFlows = await fetchJSON(`/api/top-flows?sinceMinutes=${state.sinceMinutes}&minXrp=${state.minXrp}`);
      renderTable(newFlows);
    })
  );

  const table = h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'When'),
      h('th', {}, 'Tx'),
      h('th', {}, 'From'),
      h('th', {}, 'To'),
      h('th', {}, 'Amount'),
      h('th', {}, 'Direction'),
      h('th', {}, 'Likelihood'),
      h('th', {}, 'Open')
    )),
    h('tbody')
  );

  function renderTable(data) {
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';

    if (!Array.isArray(data) || data.length === 0) {
      tbody.append(emptyRow(8));
      return;
    }

    for (const f of data) {
      const amt = `${fmt.format(Math.round(f.amount_xrp))} XRP`;
      const usd = `( $${fmt.format(Math.round(f.amount_usd))} )`;
      const row = h('tr', {},
        h('td', { class: 'muted' }, new Date(f.ts).toLocaleTimeString()),
        h('td', { class: 'mono' }, f.hash?.slice(0, 6) + '...' + f.hash?.slice(-4)),
        h('td', {}, f.fromLabel || f.from),
        h('td', {}, f.toLabel || f.to),
        h('td', { class: 'bold' }, amt, ' ', h('span', { class: 'muted' }, usd)),
        h('td', {}, directionChip(f.direction)),
        h('td', {}, scorePill(f.score)),
        h('td', { class: 'right' },
          h('a', {
            href: `https://xrpscan.com/tx/${encodeURIComponent(f.hash)}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'btn'
          }, 'XRPSCAN')
        )
      );
      tbody.append(row);
    }
  }

  const flowsSection = h('section', { id: 'flows' }, flowsHead, table);
  root.append(flowsSection);

  // initial table render
  renderTable(flows || []);

  // footer
  const footer = h('footer', { class: 'footer' },
    h('div', {}, `© ${new Date().getFullYear()} XRPL DeepFlow • Not affiliated with Ripple. Data via XRPSCAN.`)
  );
  root.append(footer);
}

// First render immediately
render();

// Re-render periodically (refresh data only)
if (state.timer) clearInterval(state.timer);
state.timer = setInterval(() => {
  // Only refresh the data portions (cheap path): rebuild entire view for simplicity
  render();
}, 60_000);
