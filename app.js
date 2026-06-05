const SHEET_ID = '1vyOL8IAYlsTnqvLL8_B6LeG5P2BOPyATnjTIEZxgCK0';
const KOMMO_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Dados_Kommo`;
const FB_URL    = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Custos_Facebook`;

// GT Mídia brand colors
const C = {
  yellow:  '#FCBC06',
  white:   '#ffffff',
  gray:    '#6B6B6B',
  dark:    '#2a2a2a',
  bg:      '#0a0a0a',
  seg:     ['#3a3a3a', '#FCBC06', '#e0a800', '#b8890a', '#888888'],
};

// Valores de auditoria que indicam reunião realizada
const AUDITORIA_RR = new Set(['Qualificado', 'Desqualificado']);

const MQL_SEGMENTS = new Set([
  'de_1.500_a_3.000_clientes',
  'de_3.000_a_6.000_clientes',
  'de_6.000_a_10.000_clientes',
  'mais_de_10.000_clientes',
]);

const SEGMENTS = [
  { key: 'de_100_a_1.500_clientes',    label: '100–1.500'    },
  { key: 'de_1.500_a_3.000_clientes',  label: '1.500–3.000'  },
  { key: 'de_3.000_a_6.000_clientes',  label: '3.000–6.000'  },
  { key: 'de_6.000_a_10.000_clientes', label: '6.000–10.000' },
  { key: 'mais_de_10.000_clientes',    label: '10.000+'      },
];

let allLeads = [], allCosts = [];
let charts   = {};
let tableSort = { campanhas: { col: 'leads', asc: false }, conjuntos: { col: 'leads', asc: false }, anuncios: { col: 'leads', asc: false } };

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
  if (row.length) { row.push(cell.trim()); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

// ── Value parsers ───────────────────────────────────────────────

function parseDate(val) {
  if (!val) return null;
  val = val.trim();
  if (/^\d{4,5}$/.test(val)) {
    // Excel serial → UTC date → re-parse as local to avoid UTC offset issues
    const utc = new Date((parseInt(val) - 25569) * 86400 * 1000);
    return new Date(utc.toISOString().slice(0, 10) + 'T00:00:00');
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(val)) {
    const datePart = val.split(' ')[0]; // ignora HH:mm se vier junto
    const [d, m, y] = datePart.split('/');
    return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return new Date(val + 'T00:00:00');
  return null;
}

function parseAmount(val) {
  if (!val) return 0;
  val = val.trim().replace(/\s/g, '');
  if (val.includes(',') && val.includes('.')) return parseFloat(val.replace(/\./g, '').replace(',', '.')) || 0;
  if (val.includes(',')) return parseFloat(val.replace(',', '.')) || 0;
  return parseFloat(val) || 0;
}

// ── Row parsers ─────────────────────────────────────────────────
// Dados_Kommo: 0:Id 1:Nome 2:Data 3:Status 4:Valor 5:Base
//             6:Camp 7:Conj 8:Anun 9:CampTrat 10:ConjTrat 11:AnunTrat
//             12:DataAgend 13:DataReuniao 14:Auditoria 15:DataEntrada 16:Produto

function parseLead(row) {
  if (!row || row.length < 3) return null;
  const date = parseDate(row[2]);
  if (!date || isNaN(date)) return null;
  return {
    date,
    valor:           parseAmount(row[4]),
    baseClientes:    row[5]  || '',
    campanhaTratada: row[9]  || '',
    conjuntoTratado: row[10] || '',
    anuncioTratado:  row[11] || '',
    dataAgend:       parseDate(row[12]),    // filtrado por data do agendamento
    dataReuniao:     parseDate(row[13]),   // filtrado por data da reunião
    auditoria:       row[14] || '',
    dataEntrada:     parseDate(row[15]),   // filtrado por data de entrada (venda)
  };
}

// Custos_Facebook: 0:Day 1:AmtSpent 2:CampName 3:AdSet 4:AdName
//                 5:Campanha 6:Conjunto 7:Anuncio 8:DataFmt

function parseCost(row) {
  if (!row || row.length < 7) return null;
  const date = parseDate(row[0]);
  if (!date || isNaN(date)) return null;
  return {
    date,
    amountSpent: parseAmount(row[1]),
    campanha:    row[5] || '',
    conjunto:    row[6] || '',
    anuncio:     row[7] || '',
  };
}

// ── Helpers ─────────────────────────────────────────────────────

const isMql = l => MQL_SEGMENTS.has(l.baseClientes);

function fmtBRL(v) {
  if (v == null || !isFinite(v)) return '—';
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n, d) {
  if (!d) return '—';
  return (n / d * 100).toFixed(1) + '%';
}
function labelOf(s, max) {
  if (!s) return '—';
  const c = s.replace(/\[[^\]]*\]\s*/g, '').trim();
  const t = c || s;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ── Filtering ───────────────────────────────────────────────────

let filterFrom = null, filterTo = null;

function getFilter() {
  return { from: filterFrom, to: filterTo };
}
const inRange = (x, { from, to }) =>
  !(from && x.date < from) && !(to && x.date > to);

// ── Aggregation ─────────────────────────────────────────────────

function aggregateGroup(leads, costs, leadKey, costKey) {
  const map = {};
  for (const l of leads) {
    const k = leadKey(l);
    if (!k) continue;
    if (!map[k]) {
      const segs = {};
      SEGMENTS.forEach(s => segs[s.key] = 0);
      map[k] = { name: k, leads: 0, mqls: 0, investimento: 0, segs };
    }
    map[k].leads++;
    if (isMql(l)) map[k].mqls++;
    if (l.baseClientes && map[k].segs[l.baseClientes] !== undefined) map[k].segs[l.baseClientes]++;
  }
  for (const c of costs) {
    const k = costKey(c);
    if (k && map[k]) map[k].investimento += c.amountSpent;
  }
  return Object.values(map).map(r => ({
    ...r,
    conv:   r.leads > 0 ? r.mqls / r.leads : 0,
    cpl:    r.leads > 0 && r.investimento > 0 ? r.investimento / r.leads : null,
    cpmql:  r.mqls  > 0 && r.investimento > 0 ? r.investimento / r.mqls  : null,
  }));
}

function aggregateDaily(leads, from, to) {
  const map = {};
  for (const l of leads) {
    const day = l.date.toISOString().slice(0, 10);
    if (!map[day]) map[day] = { date: day, leads: 0, mqls: 0 };
    map[day].leads++;
    if (isMql(l)) map[day].mqls++;
  }

  const periodDays = (from && to)
    ? Math.round((to.getTime() - from.getTime()) / 86400000) + 1
    : 999;
  const isOneDay = periodDays === 1;

  if (isOneDay) {
    // Período de 1 dia: mostra só esse dia
    if (from) {
      const key = from.toISOString().slice(0, 10);
      if (!map[key]) map[key] = { date: key, leads: 0, mqls: 0 };
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }

  // Preenche todos os dias do período com 0
  if (from && to) {
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const key = d.toISOString().slice(0, 10);
      if (!map[key]) map[key] = { date: key, leads: 0, mqls: 0 };
      d.setDate(d.getDate() + 1);
    }
  }

  const series = Object.values(map).sort((a, b) => a.date.localeCompare(b.date));

  // Expande para mínimo 7 apenas se período > 1 dia e série < 7
  if (series.length < 7) {
    const firstDate = series.length > 0
      ? new Date(series[0].date)
      : (from ? new Date(from) : new Date());
    while (series.length < 7) {
      firstDate.setDate(firstDate.getDate() - 1);
      const key = firstDate.toISOString().slice(0, 10);
      series.unshift({ date: key, leads: 0, mqls: 0 });
    }
  }

  return series;
}

function aggregateSegments(leads) {
  const counts = Object.fromEntries(SEGMENTS.map(s => [s.key, 0]));
  for (const l of leads) if (counts[l.baseClientes] !== undefined) counts[l.baseClientes]++;
  return SEGMENTS.map(s => ({ ...s, count: counts[s.key] }));
}

// ── Chart defaults ──────────────────────────────────────────────

Chart.defaults.color       = C.gray;
Chart.defaults.borderColor = C.dark;
Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";

function mkChart(id, type, data, opts) {
  const ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, { type, data, options: { responsive: true, maintainAspectRatio: false, ...opts } });
}

// ── Chart renderers ─────────────────────────────────────────────

function renderDailyChart(series) {
  const labels = series.map(d => {
    const [y, m, day] = d.date.split('-');
    return `${day}/${m}`;
  });
  mkChart('chartDaily', 'line', {
    labels,
    datasets: [
      {
        label: 'Leads',
        data: series.map(d => d.leads),
        borderColor: C.white,
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 2,
        pointRadius: series.length > 40 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.3,
      },
      {
        label: 'MQLs',
        data: series.map(d => d.mqls),
        borderColor: C.yellow,
        backgroundColor: 'rgba(252,188,6,0.12)',
        borderWidth: 2,
        pointRadius: series.length > 40 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.3,
      },
    ],
  }, {
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: C.gray, boxWidth: 10, padding: 14, font: { size: 11 } } },
      tooltip: { callbacks: { title: ctx => series[ctx[0].dataIndex].date } },
    },
    scales: {
      x: { ticks: { color: C.gray, font: { size: 10 }, maxTicksLimit: 12 }, grid: { color: '#1a1a1a' } },
      y: { ticks: { color: C.gray, font: { size: 10 } }, grid: { color: '#1a1a1a' }, beginAtZero: true },
    },
  });
}

function renderSegmentChart(segs) {
  mkChart('chartSegments', 'doughnut', {
    labels: segs.map(s => s.label),
    datasets: [{
      data: segs.map(s => s.count),
      backgroundColor: C.seg,
      borderColor: '#111111',
      borderWidth: 3,
    }],
  }, {
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: C.gray, padding: 10, boxWidth: 10, font: { size: 10 } },
      },
    },
  });
}

// ── KPI cards ───────────────────────────────────────────────────

function renderKpis(leads, costs, reunAgendArr, reunReais, vendasArr) {
  const total     = leads.length;
  const mqls      = leads.filter(isMql).length;
  const invest    = costs.reduce((s, c) => s + c.amountSpent, 0);
  const cpl       = total > 0 && invest > 0 ? invest / total : null;
  const cpmql     = mqls  > 0 && invest > 0 ? invest / mqls  : null;

  const reunAgend   = reunAgendArr.length;
  const reunReal    = reunReais.length;
  const vendas      = vendasArr.length;
  const receita     = vendasArr.reduce(function(s, l) { return s + (l.valor || 0); }, 0);
  const cpra        = reunAgend > 0 && invest > 0 ? invest / reunAgend : null;
  const cprr        = reunReal  > 0 && invest > 0 ? invest / reunReal  : null;
  const cpv         = vendas    > 0 && invest > 0 ? invest / vendas    : null;
  const ticketMedio = vendas    > 0 && receita > 0 ? receita / vendas  : null;
  const roas        = invest    > 0 && receita > 0 ? receita / invest   : null;

  // Linha 1 — volumes
  document.getElementById('kpiLeads').textContent     = total.toLocaleString('pt-BR');
  document.getElementById('kpiMqls').textContent      = mqls.toLocaleString('pt-BR');
  document.getElementById('kpiReunAgend').textContent = reunAgend.toLocaleString('pt-BR');
  document.getElementById('kpiReunReal').textContent  = reunReal.toLocaleString('pt-BR');
  document.getElementById('kpiVendas').textContent    = vendas.toLocaleString('pt-BR');
  document.getElementById('kpiInvest').textContent    = fmtBRL(invest);

  // Linha 2 — custos
  document.getElementById('kpiConv').textContent      = fmtPct(mqls, total);
  document.getElementById('kpiCpl').textContent       = cpl   != null ? fmtBRL(cpl)   : '—';
  document.getElementById('kpiCpmql').textContent     = cpmql != null ? fmtBRL(cpmql) : '—';
  document.getElementById('kpiCpra').textContent       = cpra        != null ? fmtBRL(cpra)        : '—';
  document.getElementById('kpiCprr').textContent       = cprr        != null ? fmtBRL(cprr)        : '—';
  document.getElementById('kpiCpv').textContent        = cpv         != null ? fmtBRL(cpv)         : '—';
  document.getElementById('kpiReceita').textContent    = fmtBRL(receita);
  document.getElementById('kpiTicket').textContent     = ticketMedio != null ? fmtBRL(ticketMedio) : '—';
  document.getElementById('kpiRoas').textContent       = roas        != null ? roas.toFixed(2) + 'x' : '—';
}

// ── Full table renderer ─────────────────────────────────────────

const TABLE_COLS = [
  { id: 'name',        label: 'Nome',          align: 'left',  sortable: true },
  { id: 'leads',       label: 'Leads',         align: 'right', sortable: true },
  { id: 'seg0',        label: '100–1.500',     align: 'right', sortable: false, cls: 'hide-mobile' },
  { id: 'seg1',        label: '1.500–3.000',   align: 'right', sortable: false, cls: 'hide-mobile' },
  { id: 'seg2',        label: '3.000–6.000',   align: 'right', sortable: false, cls: 'hide-mobile' },
  { id: 'seg3',        label: '6.000–10.000',  align: 'right', sortable: false, cls: 'hide-mobile' },
  { id: 'seg4',        label: '10.000+',       align: 'right', sortable: false, cls: 'hide-mobile' },
  { id: 'mqls',        label: 'MQL',           align: 'right', sortable: true },
  { id: 'conv',        label: '% MQL',         align: 'right', sortable: true },
  { id: 'investimento',label: 'Investimento',  align: 'right', sortable: true, cls: 'hide-mobile' },
  { id: 'cpl',         label: 'CPL',           align: 'right', sortable: true },
  { id: 'cpmql',       label: 'CPMQL',         align: 'right', sortable: true, cls: 'hide-mobile' },
];

const SORT_KEYS = {
  name:         r => (r.name || '').toLowerCase(),
  leads:        r => r.leads,
  mqls:         r => r.mqls,
  conv:         r => r.conv,
  investimento: r => r.investimento,
  cpl:          r => r.cpl  ?? Infinity,
  cpmql:        r => r.cpmql ?? Infinity,
};

function sortArrows(state, colId) {
  const aY = state.col === colId && state.asc  ? C.yellow : '#333';
  const dY = state.col === colId && !state.asc ? C.yellow : '#333';
  return `<span style="font-size:9px;cursor:pointer;color:${aY}" data-sort="${colId}" data-dir="asc">▲</span><span style="font-size:9px;cursor:pointer;color:${dY}" data-sort="${colId}" data-dir="desc">▼</span>`;
}

function renderHead(headId, tableId) {
  const state = tableSort[tableId];
  document.getElementById(headId).innerHTML = TABLE_COLS.map(col => `
    <th class="px-3 py-2.5 text-${col.align} text-xs font-medium ${col.cls || ''}" style="color:#6B6B6B;white-space:nowrap">
      ${col.label}${col.sortable ? ' ' + sortArrows(state, col.id) : ''}
    </th>
  `).join('');

  document.getElementById(headId).querySelectorAll('[data-sort]').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.sort, tbl = tableId, dir = el.dataset.dir;
      tableSort[tbl].col = col;
      tableSort[tbl].asc = dir === 'asc';
      const filter = getFilter();
      const leads  = allLeads.filter(l => inRange(l, filter) && l.campanhaTratada);
      const costs  = allCosts.filter(c => inRange(c, filter));
      const data   = aggregateGroup(leads, costs, ...getKeyFns(tbl));
      renderHead(headId, tbl);
      renderBody(`body${capitalize(tbl)}`, data, tbl);
    });
  });
}

function getKeyFns(tableId) {
  if (tableId === 'campanhas') return [l => l.campanhaTratada,  c => c.campanha];
  if (tableId === 'conjuntos') return [l => l.conjuntoTratado,  c => c.conjunto];
  return                              [l => l.anuncioTratado,   c => c.anuncio];
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function renderBody(bodyId, data, tableId) {
  const state = tableSort[tableId];
  const fn    = SORT_KEYS[state.col] || (r => r[state.col]);
  const dir   = state.asc ? 1 : -1;
  const sorted = [...data].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const tbody = document.getElementById(bodyId);
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="px-4 py-10 text-center" style="color:#3a3a3a">Sem dados no período.</td></tr>`;
    return;
  }

  const mqlColor = C.yellow;

  // Totals from full data set (regardless of sort order)
  const tLeads  = data.reduce((s, r) => s + r.leads, 0);
  const tMqls   = data.reduce((s, r) => s + r.mqls,  0);
  const tInvest = data.reduce((s, r) => s + r.investimento, 0);
  const tCpl    = tLeads > 0 && tInvest > 0 ? tInvest / tLeads : null;
  const tCpmql  = tMqls  > 0 && tInvest > 0 ? tInvest / tMqls  : null;
  const tSegs   = SEGMENTS.map(s => data.reduce((sum, r) => sum + r.segs[s.key], 0));

  tbody.innerHTML = sorted.map((r, i) => `
    <tr style="background:${i % 2 ? 'transparent' : 'rgba(252,188,6,0.02)'}">
      <td class="px-3 py-2.5" style="color:#e0e0e0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${labelOf(r.name, 38)}</td>
      <td class="px-3 py-2.5 text-right font-mono text-white">${r.leads}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#6B6B6B">${r.segs[SEGMENTS[0].key]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${r.segs[SEGMENTS[1].key]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${r.segs[SEGMENTS[2].key]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${r.segs[SEGMENTS[3].key]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${r.segs[SEGMENTS[4].key]}</td>
      <td class="px-3 py-2.5 text-right font-mono font-semibold" style="color:${mqlColor}">${r.mqls}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:#fff">${fmtPct(r.mqls, r.leads)}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#6B6B6B">${r.investimento > 0 ? fmtBRL(r.investimento) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono text-white">${r.cpl != null ? fmtBRL(r.cpl) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${r.cpmql != null ? '#9a9a9a' : '#3a3a3a'}">${r.cpmql != null ? fmtBRL(r.cpmql) : 'SEM MQL'}</td>
    </tr>
  `).join('') + `
    <tr style="background:#1a1a1a;border-top:2px solid #FCBC06">
      <td class="px-3 py-2.5 text-xs font-bold" style="color:#FCBC06">TOTAL</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold text-white">${tLeads}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#6B6B6B">${tSegs[0]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${tSegs[1]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${tSegs[2]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${tSegs[3]}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${mqlColor}">${tSegs[4]}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${mqlColor}">${tMqls}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold text-white">${fmtPct(tMqls, tLeads)}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#6B6B6B">${tInvest > 0 ? fmtBRL(tInvest) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold text-white">${tCpl != null ? fmtBRL(tCpl) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${tCpmql != null ? '#9a9a9a' : '#3a3a3a'}">${tCpmql != null ? fmtBRL(tCpmql) : 'SEM MQL'}</td>
    </tr>
  `;
}

function renderAllTables(leads, costs) {
  const tables = ['campanhas', 'conjuntos', 'anuncios'];
  tables.forEach(t => {
    const headId = `head${capitalize(t)}`;
    const bodyId = `body${capitalize(t)}`;
    const data = aggregateGroup(leads, costs, ...getKeyFns(t));
    renderHead(headId, t);
    renderBody(bodyId, data, t);
  });
}

// ── Aba Comercial ────────────────────────────────────────────────

const TABLE_COLS_COM = [
  { id: 'name',        label: 'Nome',        align: 'left',  sortable: true  },
  { id: 'leads',       label: 'Leads',       align: 'right', sortable: true  },
  { id: 'mqls',        label: 'MQL',         align: 'right', sortable: true  },
  { id: 'conv',        label: '% MQL',       align: 'right', sortable: true  },
  { id: 'investimento',label: 'Investimento',align: 'right', sortable: true, cls: 'hide-mobile' },
  { id: 'cpl',         label: 'CPL',         align: 'right', sortable: true  },
  { id: 'cpmql',       label: 'CPMQL',       align: 'right', sortable: true, cls: 'hide-mobile' },
  { id: 'ra',          label: 'RA',          align: 'right', sortable: true  },
  { id: 'cpra',        label: 'CPRA',        align: 'right', sortable: true, cls: 'hide-mobile' },
  { id: 'rr',          label: 'RR',          align: 'right', sortable: true  },
  { id: 'cprr',        label: 'CPRR',        align: 'right', sortable: true, cls: 'hide-mobile' },
  { id: 'vendas',      label: 'Vendas',      align: 'right', sortable: true  },
  { id: 'cpv',         label: 'CPV',         align: 'right', sortable: true, cls: 'hide-mobile' },
];

const SORT_KEYS_COM = {
  name:         r => (r.name || '').toLowerCase(),
  leads:        r => r.leads,
  mqls:         r => r.mqls,
  conv:         r => r.conv,
  investimento: r => r.investimento,
  cpl:          r => r.cpl    ?? Infinity,
  cpmql:        r => r.cpmql  ?? Infinity,
  ra:           r => r.ra,
  cpra:         r => r.cpra   ?? Infinity,
  rr:           r => r.rr,
  cprr:         r => r.cprr   ?? Infinity,
  vendas:       r => r.vendas,
  cpv:          r => r.cpv    ?? Infinity,
};

function aggregateGroupComercial(leads, costs, reunAgendArr, reunReais, vendasArr, leadKey, costKey) {
  const map = {};

  for (const l of leads) {
    const k = leadKey(l);
    if (!k) continue;
    if (!map[k]) map[k] = { name: k, leads: 0, mqls: 0, investimento: 0, ra: 0, rr: 0, vendas: 0 };
    map[k].leads++;
    if (isMql(l)) map[k].mqls++;
  }

  // RA: filtrado pela data do agendamento
  for (const l of reunAgendArr) {
    const k = leadKey(l);
    if (k && map[k]) map[k].ra++;
  }

  // RR: filtrado pela data da reunião
  for (const l of reunReais) {
    const k = leadKey(l);
    if (k && map[k]) map[k].rr++;
  }

  // Vendas: filtrado pela data de entrada
  for (const l of vendasArr) {
    const k = leadKey(l);
    if (k && map[k]) map[k].vendas++;
  }

  for (const c of costs) {
    const k = costKey(c);
    if (k && map[k]) map[k].investimento += c.amountSpent;
  }

  return Object.values(map).map(r => ({
    ...r,
    conv:  r.leads > 0 ? r.mqls / r.leads : 0,
    cpl:   r.leads > 0 && r.investimento > 0 ? r.investimento / r.leads  : null,
    cpmql: r.mqls  > 0 && r.investimento > 0 ? r.investimento / r.mqls   : null,
    cpra:  r.ra    > 0 && r.investimento > 0 ? r.investimento / r.ra     : null,
    cprr:  r.rr    > 0 && r.investimento > 0 ? r.investimento / r.rr     : null,
    cpv:   r.vendas > 0 && r.investimento > 0 ? r.investimento / r.vendas : null,
  }));
}

let tableSortCom = {
  campanhasC:  { col: 'leads', asc: false },
  conjuntosC:  { col: 'leads', asc: false },
  anunciosC:   { col: 'leads', asc: false },
};

function sortArrowsCom(state, colId) {
  const aY = state.col === colId && state.asc  ? C.yellow : '#333';
  const dY = state.col === colId && !state.asc ? C.yellow : '#333';
  return `<span style="font-size:9px;cursor:pointer;color:${aY}" data-sort-com="${colId}" data-dir-com="asc">▲</span><span style="font-size:9px;cursor:pointer;color:${dY}" data-sort-com="${colId}" data-dir-com="desc">▼</span>`;
}

function renderHeadCom(headId, tableId) {
  const state = tableSortCom[tableId];
  document.getElementById(headId).innerHTML = TABLE_COLS_COM.map(col => `
    <th class="px-3 py-2.5 text-${col.align} text-xs font-medium ${col.cls || ''}" style="color:#6B6B6B;white-space:nowrap">
      ${col.label}${col.sortable ? ' ' + sortArrowsCom(state, col.id) : ''}
    </th>
  `).join('');

  document.getElementById(headId).querySelectorAll('[data-sort-com]').forEach(el => {
    el.addEventListener('click', () => {
      const col = el.dataset.sortCom, tbl = tableId, dir = el.dataset.dirCom;
      tableSortCom[tbl].col = col;
      tableSortCom[tbl].asc = dir === 'asc';
      const filter    = getFilter();
      const leads     = allLeads.filter(l => inRange(l, filter) && l.campanhaTratada);
      const costs     = allCosts.filter(c => inRange(c, filter));
      const _agora    = new Date();
      const reunReais = allLeads.filter(l => l.campanhaTratada && l.dataReuniao && AUDITORIA_RR.has(l.auditoria) && l.dataReuniao <= _agora && inRange({ date: l.dataReuniao }, filter));
      const base      = tbl.replace('C', ''); // 'campanhasC' → 'campanhas'
      const kfns      = getKeyFns(base);
      const bodyId    = `bodyCom${capitalize(base)}`;
      renderHeadCom(headId, tbl);
      const _agendArr  = allLeads.filter(function(l) { return l.campanhaTratada && l.dataAgend    && inRange({ date: l.dataAgend    }, filter); });
      const _vendasArr = allLeads.filter(function(l) { return l.campanhaTratada && l.dataEntrada && inRange({ date: l.dataEntrada }, filter); });
      renderBodyCom(bodyId, aggregateGroupComercial(leads, costs, _agendArr, reunReais, _vendasArr, ...kfns), tbl);
    });
  });
}

function renderBodyCom(bodyId, data, tableId) {
  const state  = tableSortCom[tableId];
  const fn     = SORT_KEYS_COM[state.col] || (r => r[state.col]);
  const dir    = state.asc ? 1 : -1;
  const sorted = [...data].sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return av < bv ? -dir : av > bv ? dir : 0;
  });

  const tbody = document.getElementById(bodyId);
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="px-4 py-10 text-center" style="color:#3a3a3a">Sem dados no período.</td></tr>`;
    return;
  }

  const Y = C.yellow, G = '#6B6B6B', W = '#ffffff';
  const fmtN = v => v != null ? fmtBRL(v) : '—';

  // Totais
  const tL = data.reduce((s,r) => s + r.leads, 0);
  const tM = data.reduce((s,r) => s + r.mqls, 0);
  const tI = data.reduce((s,r) => s + r.investimento, 0);
  const tRA = data.reduce((s,r) => s + r.ra, 0);
  const tRR = data.reduce((s,r) => s + r.rr, 0);
  const tV  = data.reduce((s,r) => s + r.vendas, 0);

  tbody.innerHTML = sorted.map((r, i) => `
    <tr style="background:${i % 2 ? 'transparent' : 'rgba(252,188,6,0.02)'}">
      <td class="px-3 py-2.5" style="color:#e0e0e0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${labelOf(r.name, 35)}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:${W}">${r.leads}</td>
      <td class="px-3 py-2.5 text-right font-mono font-semibold" style="color:${Y}">${r.mqls}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:${W}">${fmtPct(r.mqls, r.leads)}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${r.investimento > 0 ? fmtBRL(r.investimento) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:${W}">${fmtN(r.cpl)}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#9a9a9a">${r.cpmql != null ? fmtBRL(r.cpmql) : 'SEM MQL'}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:${Y}">${r.ra}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${fmtN(r.cpra)}</td>
      <td class="px-3 py-2.5 text-right font-mono" style="color:${Y}">${r.rr}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${fmtN(r.cprr)}</td>
      <td class="px-3 py-2.5 text-right font-mono font-semibold" style="color:${Y}">${r.vendas}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${fmtN(r.cpv)}</td>
    </tr>
  `).join('') + `
    <tr style="background:#1a1a1a;border-top:2px solid #FCBC06">
      <td class="px-3 py-2.5 text-xs font-bold" style="color:#FCBC06">TOTAL</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${W}">${tL}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${Y}">${tM}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${W}">${fmtPct(tM, tL)}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${tI > 0 ? fmtBRL(tI) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${W}">${tL > 0 && tI > 0 ? fmtBRL(tI/tL) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:#9a9a9a">${tM > 0 && tI > 0 ? fmtBRL(tI/tM) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${Y}">${tRA}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${tRA > 0 && tI > 0 ? fmtBRL(tI/tRA) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${Y}">${tRR}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${tRR > 0 && tI > 0 ? fmtBRL(tI/tRR) : '—'}</td>
      <td class="px-3 py-2.5 text-right font-mono font-bold" style="color:${Y}">${tV}</td>
      <td class="px-3 py-2.5 text-right font-mono hide-mobile" style="color:${G}">${tV > 0 && tI > 0 ? fmtBRL(tI/tV) : '—'}</td>
    </tr>
  `;
}

function renderAllTablesComercial(leads, costs, reunAgendArr, reunReais, vendasArr) {
  const tables = ['campanhas', 'conjuntos', 'anuncios'];
  tables.forEach(t => {
    const tCom  = t + 'C';
    const headId = `headCom${capitalize(t)}`;
    const bodyId = `bodyCom${capitalize(t)}`;
    const data   = aggregateGroupComercial(leads, costs, reunAgendArr, reunReais, vendasArr, ...getKeyFns(t));
    renderHeadCom(headId, tCom);
    renderBodyCom(bodyId, data, tCom);
  });
}

// ── Status ──────────────────────────────────────────────────────

function setStatus(text, state) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.style.background = state === 'ok' ? '#4ade80' : state === 'err' ? '#f87171' : C.yellow;
}

function setDates(from, to) {
  filterFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0);
  filterTo   = new Date(to.getFullYear(),   to.getMonth(),   to.getDate(),  23, 59, 59);
}

const PERIOD_LABELS = {
  today:     'Hoje',
  yesterday: 'Ontem',
  week:      'Esta semana',
  lastweek:  'Última semana',
  month:     'Este mês',
  lastmonth: 'Mês passado',
  year:      'Este ano',
  custom:    'Personalizado',
};

let activePeriod = 'month';

function applyPeriod(period, skipRender) {
  activePeriod = period;
  const now = new Date();

  if (period === 'today') {
    setDates(now, now);
  } else if (period === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    setDates(d, d);
  } else if (period === 'week') {
    const day = now.getDay();
    const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    setDates(mon, sun);
  } else if (period === 'lastweek') {
    const day = now.getDay();
    const thisMon = new Date(now); thisMon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
    const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
    setDates(lastMon, lastSun);
  } else if (period === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    setDates(first, last);
  } else if (period === 'lastmonth') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    setDates(first, last);
  } else if (period === 'year') {
    const first = new Date(now.getFullYear(), 0, 1);
    const last  = new Date(now.getFullYear(), 11, 31);
    setDates(first, last);
  }

  const labelEl = document.getElementById('periodLabel');
  if (labelEl) labelEl.textContent = PERIOD_LABELS[period] || period;

  const customRange = document.getElementById('customRange');
  if (customRange) customRange.style.display = period === 'custom' ? 'block' : 'none';

  const dropdown = document.getElementById('periodDropdown');
  if (dropdown) dropdown.classList.add('hidden');

  document.querySelectorAll('.period-option').forEach(b => {
    b.classList.toggle('active-option', b.dataset.period === period);
  });

  if (!skipRender && period !== 'custom') render();
}

// ── Main render ─────────────────────────────────────────────────

function render() {
  const filter = getFilter();
  const leads  = allLeads.filter(l => inRange(l, filter) && l.campanhaTratada);
  const costs  = allCosts.filter(c => inRange(c, filter));
  // RR: filtrado pela DATA DA REUNIÃO (não pela criação do lead)
  const agora = new Date();
  // RA: filtrado pela DATA DO AGENDAMENTO (não pela criação do lead)
  const reunAgendArr = allLeads.filter(function(l) {
    return l.campanhaTratada && l.dataAgend && inRange({ date: l.dataAgend }, filter);
  });
  // RR: filtrado pela DATA DA REUNIÃO + auditoria preenchida + já passou
  const reunReais = allLeads.filter(function(l) {
    return l.campanhaTratada && l.dataReuniao && AUDITORIA_RR.has(l.auditoria)
      && l.dataReuniao <= agora
      && inRange({ date: l.dataReuniao }, filter);
  });
  // Vendas: filtrado pela DATA DE ENTRADA (não pela criação do lead)
  const vendasArr = allLeads.filter(function(l) {
    return l.campanhaTratada && l.dataEntrada && inRange({ date: l.dataEntrada }, filter);
  });

  renderKpis(leads, costs, reunAgendArr, reunReais, vendasArr);
  renderDailyChart(aggregateDaily(leads, filter.from, filter.to));
  renderSegmentChart(aggregateSegments(leads));
  renderAllTables(leads, costs);
  renderAllTablesComercial(leads, costs, reunAgendArr, reunReais, vendasArr);
}

// ── Data load ───────────────────────────────────────────────────

async function loadData() {
  setStatus('Carregando dados...', 'loading');
  try {
    const [kr, fr] = await Promise.all([fetch(KOMMO_URL), fetch(FB_URL)]);
    if (!kr.ok || !fr.ok) throw new Error('HTTP error');
    const [kt, ft] = await Promise.all([kr.text(), fr.text()]);

    allLeads = parseCSV(kt).slice(1).map(parseLead).filter(Boolean);
    allCosts = parseCSV(ft).slice(1).map(parseCost).filter(Boolean);

    applyPeriod(activePeriod, true); // restore active period dates without re-rendering yet

    const ts = new Date().toLocaleString('pt-BR');
    document.getElementById('lastUpdate').textContent = ts;
    setStatus(`${allLeads.length} leads · ${allCosts.length} registros de custo · ${new Date().toLocaleTimeString('pt-BR')}`, 'ok');
    render();
  } catch (e) {
    setStatus('Erro ao carregar. Verifique se a planilha está pública.', 'err');
    console.error(e);
  }
}

// ── Tab navigation ──────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

document.querySelectorAll('.sec-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sec-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sec-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`sec-${btn.dataset.sec}`).classList.add('active');
  });
});

document.querySelectorAll('[data-sec-com]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-sec-com]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sec-panel-com').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`sec-com-${btn.dataset.secCom}`).classList.add('active');
  });
});

// ── Filter & reload ─────────────────────────────────────────────

// Period dropdown
const _dropBtn  = document.getElementById('periodDropdownBtn');
const _dropdown = document.getElementById('periodDropdown');

_dropBtn.addEventListener('click', e => {
  e.stopPropagation();
  _dropdown.classList.toggle('hidden');
});

document.addEventListener('click', e => {
  if (!document.getElementById('periodDropdownContainer').contains(e.target)) {
    _dropdown.classList.add('hidden');
  }
});

document.querySelectorAll('.period-option').forEach(btn => {
  btn.addEventListener('click', () => applyPeriod(btn.dataset.period));
});

// Flatpickr range picker
flatpickr('#dateRangePicker', {
  mode: 'range',
  locale: 'pt',
  dateFormat: 'd/m/Y',
  onChange(selectedDates) {
    if (selectedDates.length === 2) {
      const [s, e] = selectedDates;
      filterFrom = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0);
      filterTo   = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59);
      render();
    }
  }
});

document.getElementById('btnReload').addEventListener('click', loadData);

loadData();
