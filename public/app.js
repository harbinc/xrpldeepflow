const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) el.append(c?.nodeType ? c : document.createTextNode(c));
  return el;
};

const fmt = new Intl.NumberFormat();

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  } catch (e) {
    console.error('fetchJSON error:', e);
    return []; // <= keep UI running
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
  return h('span', { class: d.cls }, d.text);
}

function scorePill(score) {
  const tone = score >= 80 ? 'pill green' : score >= 60 ? 'pill cyan' : 'pill neutral';
  const label = score >= 80 ? 'Institutional-grade' : score >= 60 ? 'High-likelihood' : 'Notable';
  return h('span', { class: tone, title: label }, `${label} · ${score}`);
}

function emptyRow(colspan, msg = 'No large flows detected for this window') {
  return h('tr', {},
    h('td', { class: 'muted', colspan: String(colspan) }, msg)
  );
}

async function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = h('header', { class: 'topbar' },
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

  const hero = h('section', { class: 'hero' },
    h('h1', {}, 'See ', h('span', { class: 'grad' }, 'Big Money'), ' Move on XRPL'),
    h('p', { class: 'muted' }, 'Real-time detection of large XRP transfers, exchange flows, and treasury events.'),
    h('div', { class: 'badges' },
      h('span', { class: 'badge white' }, 'Dark UI'),
      h('span', { class: 'badge cyan' }, 'XRPL-native'),
      h('span', { class: 'badge' }, 'Free to use')
    )
  );

  let flows = await fetchJSON('/api/top-flows?sinceMinutes=180&minXrp=1000000');
  let heat  = await fetchJSON('/api/exchange-heatmap?sinceMinutes=180&minXrp=1000000');

  const controls = h('div', { class: 'controls' },
    h('div', {}, 'Min Amount:'),
    h('select', {
      id: 'minFilter',
      onChange: async (e) => {
        const v = parseInt(e.target.value, 10) * 1_000_000;
        const f = await fetchJSON(`/api/top-flows?sinceMinutes=180&minXrp=${v}`);
        renderTable(f);
      }
    },
      h('option', { value: '1' }, '≥ 1M XRP'),
      h('option', { value: '5' }, '≥ 5M XRP'),
      h('option', { value: '10' }, '≥ 10M XRP')
    )
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
      const tr = h('tr', {},
        h('td', { class: 'muted' }, new Date(f.ts).toLocaleTimeString()),
        h('td', { class: 'mono' }, f.hash?.slice(0, 6) + '...' + f.hash?.slice(-4)),
        h('td', {}, f.fromLabel || f.from),
        h('td', {}, f.toLabel || f.to),
        h('td', { class: 'bold' }, `${fmt.format(f.amount_xrp)} XRP `, h('span', { class: 'muted' }, `($${fmt.format(f.amount_usd)})`)),
        h('td', {}, directionChip(f.direction)),
        h('td', {}, scorePill(f.score)),
        h('td', { class: 'right' }, h('a', { href: `https://xrpscan.com/tx/${f.hash}`, target: '_blank', class: 'btn' }, 'XRPSCAN'))
      );
      tbody.append(tr);
    }
  }
  renderTable(flows);

  const tiles = h('div', { class: 'tiles' });
  if (Array.isArray(heat) && heat.length > 0) {
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

  const flowsSection = h('section', { id: 'flows' },
    h('div', { class: 'section-head' },
      h('h2', {}, "Today's Top Flows"),
      controls
    ),
    table
  );

  const exchSection = h('section', { id: 'exchanges' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Exchange Heat (24h)'),
      h('div', { class: 'muted tiny' }, 'Net inflow(+) / outflow(-) in millions of XRP')
    ),
    tiles
  );

  const footer = h('footer', { class: 'footer' },
    h('div', {}, `© ${new Date().getFullYear()} XRPL DeepFlow • Not affiliated with Ripple. Data via XRPSCAN.`)
  );

  app.append(header, hero, exchSection, flowsSection, footer);
}

render();
setInterval(render, 60_000);
