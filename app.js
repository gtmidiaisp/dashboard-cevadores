const SHEET_ID = '1vyOL8IAYlsTnqvLL8_B6LeG5P2BOPyATnjTIEZxgCK0';
const KOMMO_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Dados%20Kommo%20Tratado`;
const FB_URL    = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Custos_Facebook`;

// Segments where Base de clientes > 1500 = MQL
const MQL_SEGMENTS = new Set([
  'de_1.500_a_3.000_clientes',
  'de_3.000_a_6.000_clientes',
  'de_6.000_a_10.000_clientes',
  'mais_de_10.000_clientes',
]);

const SEGMENTS = [
  { key: 'de_100_a_1.500_clientes',    label: '100–1.500'   },
  { key: 'de_1.500_a_3.000_clientes',  label: '1.500–3.000' },
  { key: 'de_3.000_a_6.000_clientes',  label: '3.000–6.000' },
  { key: 'de_6.000_a_10.000_clientes', label: '6.000–10.000'},
  { key: 'mais_de_10.000_clientes',    label: '10.000+'     },
];

const SEG_COLORS  = ['#94a3b8','#38bdf8','#34d399','#a78bfa','#fb923c'];
const C_LEADS     = '#60a5fa';
const C_MQLS      = '#22d3ee';

let allLeads = [], allCosts = [];
let charts   = {};
let sortCol  = 'leads', sortAsc = false;

// ── CSV parser ──────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { cell += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      row.push(cell.trim()); cell = '';
    } else if ((c === '\n' || c === '\r') && !inQ) {
      row.push(cell.trim()); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

// ── Value parsers ───────────────────────────────────────────────

function parseDate(val) {
  if (!val) return null;
  val = val.trim();
  // Excel serial (4-5 digit number like 46072) — treat as local midnight to avoid UTC offset issues
  if (/^\d{4,5}$/.test(val)) {
    const d = new Date((parseInt(val) - 25569) * 86400 * 1000);
    // Convert from UTC midnight to a local-date-only string, then re-parse as local
    const iso = d.toISOString().slice(0, 10);
    return new Date(iso + 'T00:00:00');
  }
  // DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(val)) {
    const [d, m, y] = val.split('/');
    return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00`);
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return new Date(`${val}T00:00:00`);
  }
  return null;
}

function parseAmount(val) {
  if (!val) return 0;
  val = val.trim().replace(/\s/g, '');
  // "1.234,56" → 1234.56
  if (val.includes(',') && val.includes('.')) {
    return parseFloat(val.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // "34,79" → 34.79
  if (val.includes(',')) {
    return parseFloat(val.replace(',', '.')) || 0;
  }
  return parseFloat(val) || 0;
}

// ── Row parsers ─────────────────────────────────────────────────

// Dados Kommo Tratado columns (0-based):
// 0:Id  1:Nome  2:DataCriacao  3:Status  4:Valor
// 5:BaseClientes  6:Campanha  7:Conjunto  8:Anuncio
// 9:CampanhaTratada  10:ConjuntoTratada  11:AnuncioTratado
function parseLead(row) {
  if (!row || row.length < 3) return null;
  const date = parseDate(row[2]);
  if (!date || isNaN(date)) return null;
  return {
    date,
    baseClientes:     row[5]  || '',
    campanhaTratada:  row[9]  || '',
    anuncioTratado:   row[11] || '',
  };
}

// Custos_Facebook columns (0-based):
// 0:Day  1:AmountSpent  2:CampaignName  3:AdSetName  4:AdName
// 5:Campanha  6:Conjunto  7:Anuncio  8:DataFormatada
function parseCost(row) {
  if (!row || row.length < 6) return null;
  const date   = parseDate(row[0]);
  if (!date || isNaN(date)) return null;
  const amount = parseAmount(row[1]);
  return {
    date,
    amountSpent: amount,
    campanha:    row[5] || '',
    anuncio:     row[7] || '',
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function isMql(lead) {
  return MQL_SEGMENTS.has(lead.baseClientes);
}

function fmtBRL(val) {
  if (val == null || !isFinite(val)) return 'SEM MQL';
  return 'R$ ' + val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n, d) {
  if (!d) return '—';
  return (n / d * 100).toFixed(1) + '%';
}

// Remove [tags] for chart labels; fall back to original if nothing remains
function labelOf(str, maxLen) {
  if (!str) return '—';
  const clean = str.replace(/\[[^\]]*\]\s*/g, '').trim();
  const s = clean || str;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// ── Filtering ───────────────────────────────────────────────────

function getDateFilter() {
  const fv = document.getElementById('dateFrom').value;
  const tv = document.getElementById('dateTo').value;
  return {
    from: fv ? new Date(fv + 'T00:00:00') : null,
    to:   tv ? new Date(tv + 'T23:59:59') : null,
  };
}

function inRange(item, { from, to }) {
  if (from && item.date < from) return false;
  if (to   && item.date > to)   return false;
  return true;
}

// ── Aggregation ─────────────────────────────────────────────────

function aggregateCampaigns(leads, costs) {
  const map = {};
  for (const l of leads) {
    const k = l.campanhaTratada;
    if (!k) continue;
    if (!map[k]) map[k] = { campanha: k, leads: 0, mqls: 0, investimento: 0 };
    map[k].leads++;
    if (isMql(l)) map[k].mqls++;
  }
  for (const c of costs) {
    const k = c.campanha;
    if (k && map[k]) map[k].investimento += c.amountSpent;
  }
  return Object.values(map).map(c => ({
    ...c,
    conv:        c.leads > 0 ? c.mqls / c.leads : 0,
    cpl:         c.leads > 0 && c.investimento > 0 ? c.investimento / c.leads : null,
    cpmql:       c.mqls  > 0 && c.investimento > 0 ? c.investimento / c.mqls  : null,
  }));
}

function aggregateAds(leads, costs) {
  const map = {};
  for (const l of leads) {
    const k = l.anuncioTratado;
    if (!k) continue;
    if (!map[k]) map[k] = { anuncio: k, leads: 0, mqls: 0, investimento: 0 };
    map[k].leads++;
    if (isMql(l)) map[k].mqls++;
  }
  for (const c of costs) {
    const k = c.anuncio;
    if (k && map[k]) map[k].investimento += c.amountSpent;
  }
  return Object.values(map)
    .filter(a => a.investimento > 0)
    .map(a => ({
      ...a,
      cpl: a.leads > 0 ? a.investimento / a.leads : null,
    }));
}

function aggregateSegments(leads) {
  const counts = Object.fromEntries(SEGMENTS.map(s => [s.key, 0]));
  for (const l of leads) {
    if (l.baseClientes && counts[l.baseClientes] !== undefined) counts[l.baseClientes]++;
  }
  return SEGMENTS.map(s => ({ ...s, count: counts[s.key] }));
}

// ── Chart rendering ─────────────────────────────────────────────

Chart.defaults.color         = '#94a3b8';
Chart.defaults.borderColor   = '#334155';
Chart.defaults.font.family   = 'system-ui, sans-serif';

function mkChart(id, type, data, opts) {
  const ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, { type, data, options: { responsive: true, maintainAspectRatio: false, ...opts } });
}

function renderCampaignChart(campaigns) {
  const sorted = [...campaigns].sort((a, b) => b.leads - a.leads).slice(0, 10);
  mkChart('chartCampaigns', 'bar', {
    labels: sorted.map(c => labelOf(c.campanha, 20)),
    datasets: [
      { label: 'Leads', data: sorted.map(c => c.leads), backgroundColor: C_LEADS, borderRadius: 4 },
      { label: 'MQLs',  data: sorted.map(c => c.mqls),  backgroundColor: C_MQLS,  borderRadius: 4 },
    ],
  }, {
    plugins: {
      legend: { labels: { color: '#94a3b8', boxWidth: 10, padding: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          title: ctx => sorted[ctx[0].dataIndex].campanha,
          afterBody: ctx => {
            const c = sorted[ctx[0].dataIndex];
            return [`CPL: ${c.cpl != null ? fmtBRL(c.cpl) : '—'}`, `Investimento: ${fmtBRL(c.investimento)}`];
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 30 }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#334155' } },
    },
  });
}

function renderSegmentChart(segs) {
  mkChart('chartSegments', 'doughnut', {
    labels: segs.map(s => s.label),
    datasets: [{
      data: segs.map(s => s.count),
      backgroundColor: SEG_COLORS,
      borderColor: '#0f172a',
      borderWidth: 2,
    }],
  }, {
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: '#94a3b8', padding: 8, boxWidth: 10, font: { size: 10 } },
      },
    },
  });
}

function renderAdsChart(ads) {
  const sorted = [...ads].filter(a => a.cpl != null).sort((a, b) => a.cpl - b.cpl).slice(0, 8);
  mkChart('chartAds', 'bar', {
    labels: sorted.map(a => labelOf(a.anuncio, 28)),
    datasets: [{
      label: 'CPL (R$)',
      data: sorted.map(a => +a.cpl.toFixed(2)),
      backgroundColor: sorted.map(a => a.mqls >= 3 ? C_MQLS : '#1877F2'),
      borderRadius: 4,
    }],
  }, {
    indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: ctx => sorted[ctx[0].dataIndex].anuncio,
          label: ctx => {
            const a = sorted[ctx.dataIndex];
            return [`CPL: ${fmtBRL(a.cpl)}`, `Leads: ${a.leads}`, `MQLs: ${a.mqls}`];
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: '#64748b', font: { size: 10 }, callback: v => 'R$ ' + v }, grid: { color: '#334155' } },
      y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: '#1e293b' } },
    },
  });
}

// ── Table ───────────────────────────────────────────────────────

const sortKeys = {
  campanha:    c => (c.campanha || '').toLowerCase(),
  leads:       c => c.leads,
  mqls:        c => c.mqls,
  conv:        c => c.conv,
  investimento:c => c.investimento,
  cpl:         c => c.cpl  ?? Infinity,
  cpmql:       c => c.cpmql ?? Infinity,
};

function renderTable(campaigns) {
  const fn  = sortKeys[sortCol] || (c => c[sortCol]);
  const dir = sortAsc ? 1 : -1;
  const sorted = [...campaigns].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const tbody = document.getElementById('tableBody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-10 text-center" style="color:#475569">Sem dados no período selecionado.</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map((c, i) => `
    <tr style="border-top:1px solid #334155;background:${i % 2 ? 'transparent' : 'rgba(15,23,42,0.3)'}">
      <td class="px-4 py-2.5 text-xs sm:text-sm" style="color:#e2e8f0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.campanha}">${labelOf(c.campanha, 40)}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm text-white">${c.leads}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm" style="color:#22d3ee">${c.mqls}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm hidden sm:table-cell" style="color:#4ade80">${fmtPct(c.mqls, c.leads)}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm hidden md:table-cell" style="color:#60a5fa">${c.investimento > 0 ? fmtBRL(c.investimento) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm text-white">${c.cpl != null ? fmtBRL(c.cpl) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono text-xs sm:text-sm hidden sm:table-cell" style="color:${c.cpmql != null ? '#e2e8f0' : '#475569'}">${c.cpmql != null ? fmtBRL(c.cpmql) : 'SEM MQL'}</td>
    </tr>
  `).join('');
}

// ── KPI cards ───────────────────────────────────────────────────

function renderKpis(leads, costs) {
  const total     = leads.length;
  const mqls      = leads.filter(isMql).length;
  const invest    = costs.reduce((s, c) => s + c.amountSpent, 0);
  const cpl       = total > 0 && invest > 0 ? invest / total : null;
  const cpmql     = mqls  > 0 && invest > 0 ? invest / mqls  : null;

  document.getElementById('kpiLeads').textContent  = total.toLocaleString('pt-BR');
  document.getElementById('kpiMqls').textContent   = mqls.toLocaleString('pt-BR');
  document.getElementById('kpiConv').textContent   = fmtPct(mqls, total);
  document.getElementById('kpiCpl').textContent    = cpl   != null ? fmtBRL(cpl)   : '—';
  document.getElementById('kpiCpmql').textContent  = cpmql != null ? fmtBRL(cpmql) : '—';
  document.getElementById('kpiInvest').textContent = fmtBRL(invest);
}

// ── Main render ─────────────────────────────────────────────────

function render() {
  const filter = getDateFilter();
  const leads  = allLeads.filter(l => inRange(l, filter));
  const costs  = allCosts.filter(c => inRange(c, filter));

  renderKpis(leads, costs);
  const campaigns = aggregateCampaigns(leads, costs);
  renderCampaignChart(campaigns);
  renderSegmentChart(aggregateSegments(leads));
  renderAdsChart(aggregateAds(leads, costs));
  renderTable(campaigns);
}

// ── Status helpers ──────────────────────────────────────────────

function setStatus(text, state) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  const colors = { ok: '#4ade80', err: '#f87171', loading: '#eab308' };
  dot.style.background = colors[state] || colors.loading;
  dot.style.animation  = state === 'loading' ? 'pulse 1.5s infinite' : 'none';
}

function setDefaultDates() {
  const all = [...allLeads, ...allCosts].map(x => x.date.getTime()).filter(Boolean);
  if (!all.length) return;
  const min = new Date(Math.min(...all));
  const max = new Date(Math.max(...all));
  document.getElementById('dateFrom').value = min.toISOString().slice(0, 10);
  document.getElementById('dateTo').value   = max.toISOString().slice(0, 10);
}

// ── Data loading ────────────────────────────────────────────────

async function loadData() {
  setStatus('Carregando dados da planilha...', 'loading');
  try {
    const [kommoRes, fbRes] = await Promise.all([fetch(KOMMO_URL), fetch(FB_URL)]);
    if (!kommoRes.ok || !fbRes.ok) throw new Error('Resposta HTTP inválida');

    const [kommoText, fbText] = await Promise.all([kommoRes.text(), fbRes.text()]);

    const kommoRows = parseCSV(kommoText);
    const fbRows    = parseCSV(fbText);

    allLeads = kommoRows.slice(1).map(parseLead).filter(Boolean);
    allCosts = fbRows.slice(1).map(parseCost).filter(Boolean);

    if (!document.getElementById('dateFrom').value) setDefaultDates();

    document.getElementById('lastUpdate').textContent = new Date().toLocaleString('pt-BR');
    setStatus(`${allLeads.length} leads · ${allCosts.length} registros de custo · atualizado ${new Date().toLocaleTimeString('pt-BR')}`, 'ok');

    render();
  } catch (err) {
    setStatus('Erro ao carregar. Verifique se a planilha está pública (Arquivo → Compartilhar → Qualquer pessoa com o link).', 'err');
    console.error('loadData:', err);
  }
}

// ── Events ──────────────────────────────────────────────────────

document.getElementById('btnApply').addEventListener('click', render);
document.getElementById('btnReload').addEventListener('click', loadData);

document.querySelectorAll('#campaignTable th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = false; }
    const filter = getDateFilter();
    renderTable(aggregateCampaigns(
      allLeads.filter(l => inRange(l, filter)),
      allCosts.filter(c => inRange(c, filter))
    ));
  });
});

loadData();
