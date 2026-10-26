'use strict';

const STORAGE_KEY = 'expenses.v1';
const SETTINGS_KEY = 'expenses.settings.v1';
const RATES_KEY = 'expenses.rates.v1';
const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const RATES_MAX_AGE = 12 * 60 * 60 * 1000;

const CATEGORIES = [
  { id: 'food', name: 'Food & dining', icon: '🍽️', color: '#f97316' },
  { id: 'groceries', name: 'Groceries', icon: '🛒', color: '#22c55e' },
  { id: 'transport', name: 'Transport', icon: '🚌', color: '#3b82f6' },
  { id: 'shopping', name: 'Shopping', icon: '🛍️', color: '#ec4899' },
  { id: 'bills', name: 'Bills & utilities', icon: '💡', color: '#eab308' },
  { id: 'rent', name: 'Rent & housing', icon: '🏠', color: '#8b5cf6' },
  { id: 'entertainment', name: 'Entertainment', icon: '🎬', color: '#06b6d4' },
  { id: 'health', name: 'Health', icon: '💊', color: '#ef4444' },
  { id: 'travel', name: 'Travel', icon: '✈️', color: '#14b8a6' },
  { id: 'education', name: 'Education', icon: '📚', color: '#6366f1' },
  { id: 'other', name: 'Other', icon: '📦', color: '#94a3b8' },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const METHODS = ['Card', 'Cash', 'Bank transfer', 'Mobile wallet', 'Other'];
// Shown at the top of every currency list; the rest follow alphabetically.
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'SGD', 'AED', 'CHF', 'CNY'];
// Approximate units per 1 USD, used until live rates load (or when offline).
const FALLBACK_RATES = {
  USD: 1, EUR: 0.92, GBP: 0.78, INR: 84, JPY: 150, CAD: 1.37, AUD: 1.52, SGD: 1.33, AED: 3.6725,
  CHF: 0.86, CNY: 7.2, HKD: 7.8, NZD: 1.65, SEK: 10.5, NOK: 10.8, DKK: 6.9, PLN: 4, MXN: 18.5,
  BRL: 5.5, ZAR: 18, KRW: 1350, THB: 34, MYR: 4.4, IDR: 15800, PHP: 57, SAR: 3.75, TRY: 34,
  BDT: 120, PKR: 280, LKR: 300, NPR: 134,
};

const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;

/* ---------- Storage ---------- */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the app still works for this visit.
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Accepts anything that came from storage or a backup file and keeps only well-formed expenses.
// Expenses saved before currencies were per-expense get `fallbackCurrency`.
function sanitize(list, fallbackCurrency) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && Number.isFinite(+e.amount) && +e.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .map((e) => ({
      id: String(e.id || uid()),
      amount: Math.round(+e.amount * 100) / 100,
      currency: knownCurrency(e.currency) ? e.currency : fallbackCurrency,
      category: CAT[e.category] ? e.category : 'other',
      date: e.date,
      note: String(e.note || '').slice(0, 120),
      method: METHODS.includes(e.method) ? e.method : 'Other',
      createdAt: +e.createdAt || 0,
    }));
}

function guessCurrency() {
  const region = (navigator.language || 'en-US').split('-')[1]?.toUpperCase();
  const euro = ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'GR', 'LU'];
  if (euro.includes(region)) return 'EUR';
  const map = { IN: 'INR', GB: 'GBP', JP: 'JPY', CA: 'CAD', AU: 'AUD', SG: 'SGD', AE: 'AED', CH: 'CHF', CN: 'CNY' };
  return map[region] || 'USD';
}

// Exchange rates are stored as units per 1 USD.
let rates = load(RATES_KEY, null);
if (!rates || typeof rates.rates !== 'object') rates = { rates: {}, fetchedAt: 0, updatedAt: 0 };

const rateOf = (code) => rates.rates[code] || FALLBACK_RATES[code];
const knownCurrency = (code) => typeof code === 'string' && rateOf(code) > 0;
const convert = (amount, from, to) => (from === to ? amount : (amount / rateOf(from)) * rateOf(to));

const settings = Object.assign(
  { currency: guessCurrency(), budget: 0, theme: null, lastCategory: 'food', lastMethod: 'Card', lastCurrency: null },
  load(SETTINGS_KEY, {})
);
if (!knownCurrency(settings.currency)) settings.currency = 'USD';
let expenses = sanitize(load(STORAGE_KEY, []), settings.currency);
// Write back right away so older expenses keep the currency they were given above.
if (expenses.length) save(STORAGE_KEY, expenses);
const now = new Date();
const view = { year: now.getFullYear(), month: now.getMonth() };
const filters = { q: '', cat: 'all', sort: 'date-desc' };
let editingId = null;

const persist = () => save(STORAGE_KEY, expenses);
const saveSettings = () => save(SETTINGS_KEY, settings);

/* ---------- Formatting ---------- */

const formatters = new Map();
function formatter(currency, short = false) {
  const key = currency + (short ? ':short' : '');
  if (!formatters.has(key)) {
    const opts = { style: 'currency', currency };
    if (short) opts.maximumFractionDigits = 0;
    formatters.set(key, new Intl.NumberFormat(undefined, opts));
  }
  return formatters.get(key);
}

let currencyNames;
try {
  currencyNames = new Intl.DisplayNames(undefined, { type: 'currency' });
} catch {
  currencyNames = null;
}
const currencyName = (code) => currencyNames?.of(code) || code;

// Totals are always shown in the main currency.
const fmt = (n) => formatter(settings.currency).format(n);
const fmtShort = (n) => formatter(settings.currency, true).format(n);
const fmtIn = (n, currency) => formatter(currency).format(n);
const toMain = (e) => convert(e.amount, e.currency, settings.currency);
const sum = (list) => list.reduce((t, e) => t + toMain(e), 0);

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const monthName = (y, m, opts = { month: 'long', year: 'numeric' }) =>
  new Date(y, m, 1).toLocaleDateString(undefined, opts);
const prevMonthOf = (y, m) => (m === 0 ? [y - 1, 11] : [y, m - 1]);

// Where the viewed month sits relative to today: -1 past, 0 current, 1 future.
function monthPosition() {
  const t = new Date();
  const a = view.year * 12 + view.month;
  const b = t.getFullYear() * 12 + t.getMonth();
  return Math.sign(a - b);
}

function dayLabel(iso) {
  const t = new Date();
  if (iso === isoDate(t)) return 'Today';
  t.setDate(t.getDate() - 1);
  if (iso === isoDate(t)) return 'Yesterday';
  return parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ---------- Rendering ---------- */

function render() {
  const key = monthKey(view.year, view.month);
  const items = expenses.filter((e) => e.date.startsWith(key));
  const total = sum(items);
  const label = $('#monthLabel');
  label.textContent = monthName(view.year, view.month);
  label.classList.toggle('is-current', monthPosition() === 0);

  renderCards(items, total);
  renderDonut(items, total);
  renderBars(items);
  renderList(items);
}

function categoryTotals(items) {
  const totals = new Map();
  for (const e of items) totals.set(e.category, (totals.get(e.category) || 0) + toMain(e));
  return [...totals].map(([id, amount]) => ({ cat: CAT[id], amount })).sort((a, b) => b.amount - a.amount);
}

function renderCards(items, total) {
  const pos = monthPosition();
  const dim = daysIn(view.year, view.month);
  const [py, pm] = prevMonthOf(view.year, view.month);
  const prevTotal = sum(expenses.filter((e) => e.date.startsWith(monthKey(py, pm))));

  // Spent
  $('#spent').textContent = fmt(total);
  let spentSub = `${items.length} ${items.length === 1 ? 'expense' : 'expenses'}`;
  const currencyCount = new Set(items.map((e) => e.currency)).size;
  if (currencyCount > 1) spentSub += ` in ${currencyCount} currencies`;
  if (prevTotal > 0) {
    const change = ((total - prevTotal) / prevTotal) * 100;
    spentSub += ` · ${change >= 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(0)}% vs ${monthName(py, pm, { month: 'short' })}`;
  }
  $('#spentSub').textContent = spentSub;

  // Budget
  const budget = +settings.budget || 0;
  const bar = $('#budgetBar');
  const sub = $('#budgetSub');
  const card = $('#budgetCard');
  if (budget > 0) {
    const left = budget - total;
    const pct = (total / budget) * 100;
    $('#budgetLeft').textContent = fmt(left);
    bar.style.width = `${Math.min(pct, 100)}%`;
    bar.className = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
    card.classList.toggle('is-over', left < 0);
    if (left < 0) {
      sub.textContent = `Over budget by ${fmt(-left)}`;
    } else if (pos === 0) {
      const daysLeft = dim - new Date().getDate() + 1;
      sub.textContent = `${pct.toFixed(0)}% used · ${fmt(left / daysLeft)}/day for ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`;
    } else {
      sub.textContent = `${pct.toFixed(0)}% of ${fmt(budget)} used`;
    }
  } else {
    $('#budgetLeft').textContent = '—';
    bar.style.width = '0';
    card.classList.remove('is-over');
    sub.innerHTML = '<button class="link" data-open-settings>Set a monthly budget</button>';
  }

  // Daily average (and where the month is heading)
  const days = pos === 0 ? new Date().getDate() : dim;
  const avg = total / days;
  $('#dailyAvg').textContent = fmt(avg);
  if (pos === 0 && days < dim && total > 0) {
    $('#dailySub').textContent = `On pace for ${fmtShort(avg * dim)} this month`;
  } else {
    $('#dailySub').textContent = `Across ${days} ${days === 1 ? 'day' : 'days'}`;
  }

  // Top category
  const top = categoryTotals(items)[0];
  if (top) {
    $('#topCat').textContent = `${top.cat.icon} ${top.cat.name}`;
    $('#topCatSub').textContent = `${fmt(top.amount)} · ${((top.amount / total) * 100).toFixed(0)}% of spending`;
  } else {
    $('#topCat').textContent = '—';
    $('#topCatSub').textContent = 'Nothing spent yet';
  }
}

function renderDonut(items, total) {
  const totals = categoryTotals(items);
  const R = 48;
  const C = 2 * Math.PI * R;
  const gap = totals.length > 1 ? 1.5 : 0;
  let offset = 0;
  let segments = '';
  for (const t of totals) {
    const len = (t.amount / total) * C;
    const dim = filters.cat !== 'all' && filters.cat !== t.cat.id ? ' dim' : '';
    segments += `<circle cx="60" cy="60" r="${R}" class="donut-seg${dim}" stroke="${t.cat.color}"
      stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-offset}">
      <title>${t.cat.name}: ${fmt(t.amount)}</title></circle>`;
    offset += len;
  }
  $('#donut').innerHTML = `
    <circle cx="60" cy="60" r="${R}" class="donut-track"/>
    <g transform="rotate(-90 60 60)">${segments}</g>
    <text x="60" y="61" class="donut-total">${fmtShort(total)}</text>
    <text x="60" y="74" class="donut-caption">${totals.length ? 'total spent' : 'no spending'}</text>`;

  const legend = $('#legend');
  legend.textContent = '';
  if (!totals.length) {
    legend.innerHTML = '<li class="legend-empty">No expenses this month yet.</li>';
    return;
  }
  for (const t of totals) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.cat = t.cat.id;
    btn.className = filters.cat === t.cat.id ? 'active' : '';
    btn.title = filters.cat === t.cat.id ? 'Show all categories' : `Show only ${t.cat.name}`;
    btn.innerHTML = `<span class="swatch" style="background:${t.cat.color}"></span>
      <span class="name">${t.cat.icon} ${t.cat.name}</span>
      <span class="pct">${((t.amount / total) * 100).toFixed(0)}%</span>
      <span class="amt">${fmt(t.amount)}</span>`;
    li.append(btn);
    legend.append(li);
  }
}

function renderBars(items) {
  const dim = daysIn(view.year, view.month);
  const perDay = new Array(dim).fill(0);
  for (const e of items) perDay[+e.date.slice(8) - 1] += toMain(e);
  const max = Math.max(...perDay);
  const pos = monthPosition();
  const todayDay = pos === 0 ? new Date().getDate() : 0;
  const shortMonth = monthName(view.year, view.month, { month: 'short' });

  const el = $('#bars');
  el.textContent = '';
  perDay.forEach((amt, i) => {
    const day = i + 1;
    const col = document.createElement('div');
    col.className = 'bar-col';
    if (day === todayDay) col.classList.add('is-today');
    if (pos === 1 || (pos === 0 && day > todayDay)) col.classList.add('is-future');
    col.title = `${shortMonth} ${day}: ${fmt(amt)}`;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = max > 0 && amt > 0 ? `${Math.max((amt / max) * 100, 3)}%` : '0';
    track.append(bar);
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = day === 1 || day % 5 === 0 ? day : '';
    col.append(track, label);
    el.append(col);
  });

  const busiest = perDay.indexOf(max);
  $('#barsNote').textContent = max > 0 ? `Busiest: ${shortMonth} ${busiest + 1} · ${fmt(max)}` : '';
}

function renderList(items) {
  const q = filters.q.trim().toLowerCase();
  const rows = items.filter(
    (e) =>
      (filters.cat === 'all' || e.category === filters.cat) &&
      (!q ||
        e.note.toLowerCase().includes(q) ||
        CAT[e.category].name.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q) ||
        e.currency.toLowerCase() === q)
  );
  const [field, dir] = filters.sort.split('-');
  const sign = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) =>
    field === 'amount'
      ? sign * (toMain(a) - toMain(b))
      : sign * (a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
  );

  $('#catFilter').value = filters.cat;
  $('#listSummary').textContent = items.length ? `${rows.length} shown · ${fmt(sum(rows))}` : '';

  const list = $('#list');
  list.textContent = '';

  if (!items.length) {
    list.append(emptyState(
      '🧾',
      `No expenses in ${monthName(view.year, view.month, { month: 'long' })} yet`,
      'Add what you spend and this page shows where your money goes.',
      expenses.length === 0
    ));
    return;
  }
  if (!rows.length) {
    const empty = emptyState('🔍', 'Nothing matches your filters', 'Try a different search or category.');
    const clear = document.createElement('button');
    clear.className = 'btn';
    clear.textContent = 'Clear filters';
    clear.addEventListener('click', clearFilters);
    empty.append(clear);
    list.append(empty);
    return;
  }

  if (field === 'date') {
    let currentDay = null;
    for (const e of rows) {
      if (e.date !== currentDay) {
        currentDay = e.date;
        const dayTotal = sum(rows.filter((r) => r.date === e.date));
        const head = document.createElement('div');
        head.className = 'day-head';
        head.innerHTML = `<span></span><span>${fmt(dayTotal)}</span>`;
        head.firstChild.textContent = dayLabel(e.date);
        list.append(head);
      }
      list.append(txRow(e, false));
    }
  } else {
    for (const e of rows) list.append(txRow(e, true));
  }
}

function txRow(e, showDate) {
  const cat = CAT[e.category];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tx';
  btn.dataset.id = e.id;
  btn.title = 'Edit expense';
  btn.innerHTML = `<span class="tx-icon" style="--c:${cat.color}">${cat.icon}</span>
    <span class="tx-main"><span class="tx-title"></span><span class="tx-sub"></span></span>
    <span class="tx-amount">${fmtIn(e.amount, e.currency)}${
      e.currency === settings.currency ? '' : `<small>≈ ${fmt(toMain(e))}</small>`
    }</span>`;
  btn.querySelector('.tx-title').textContent = e.note || cat.name;
  const sub = [e.note ? cat.name : null, e.method, showDate ? dayLabel(e.date) : null].filter(Boolean);
  btn.querySelector('.tx-sub').textContent = sub.join(' · ');
  return btn;
}

function emptyState(icon, title, text, offerSample = false) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.innerHTML = `<span class="empty-icon">${icon}</span><h3></h3><p class="muted"></p>`;
  div.querySelector('h3').textContent = title;
  div.querySelector('p').textContent = text;
  const row = document.createElement('div');
  row.className = 'btn-row';
  const add = document.createElement('button');
  add.className = 'btn primary';
  add.textContent = 'Add expense';
  add.addEventListener('click', () => openExpense());
  row.append(add);
  if (offerSample) {
    const sample = document.createElement('button');
    sample.className = 'btn';
    sample.textContent = 'Try with sample data';
    sample.addEventListener('click', addSampleData);
    row.append(sample);
  }
  div.append(row);
  return div;
}

function clearFilters() {
  filters.q = '';
  filters.cat = 'all';
  $('#search').value = '';
  render();
}

/* ---------- Add / edit dialog ---------- */

const expenseDialog = $('#expenseDialog');
const form = $('#expenseForm');

function buildForm() {
  const picker = $('#catPicker');
  for (const c of CATEGORIES) {
    const label = document.createElement('label');
    label.style.setProperty('--c', c.color);
    label.innerHTML = `<input type="radio" name="category" value="${c.id}"><span>${c.icon}</span><span>${c.name}</span>`;
    picker.append(label);
  }
  $('#method').innerHTML = METHODS.map((m) => `<option>${m}</option>`).join('');
  $('#catFilter').innerHTML =
    '<option value="all">All categories</option>' +
    CATEGORIES.map((c) => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
  buildCurrencySelects();
}

// Fills both currency pickers: common currencies first, then every other currency we have a rate for.
function buildCurrencySelects() {
  const all = [...new Set([...Object.keys(FALLBACK_RATES), ...Object.keys(rates.rates)])]
    .filter((code) => /^[A-Z]{3}$/.test(code) && knownCurrency(code))
    .filter((code) => {
      try {
        formatter(code);
        return true;
      } catch {
        return false; // the browser can't format it
      }
    });
  const common = COMMON_CURRENCIES.filter((c) => all.includes(c));
  const others = all.filter((c) => !common.includes(c)).sort();
  const group = (label, codes, withNames) =>
    `<optgroup label="${label}">${codes
      .map((c) => `<option value="${c}">${withNames ? `${c} — ${currencyName(c)}` : c}</option>`)
      .join('')}</optgroup>`;
  for (const [sel, withNames] of [['#currency', true], ['#expCurrency', false]]) {
    const el = $(sel);
    const value = el.value;
    el.innerHTML = group('Common', common, withNames) + group('All currencies', others, withNames);
    if (value) el.value = value;
  }
}

function defaultDate() {
  if (monthPosition() === 0) return isoDate(new Date());
  return `${monthKey(view.year, view.month)}-01`;
}

function openExpense(id = null) {
  const e = id ? expenses.find((x) => x.id === id) : null;
  editingId = e ? e.id : null;
  $('#dialogTitle').textContent = e ? 'Edit expense' : 'Add expense';
  form.amount.value = e ? e.amount : '';
  $('#expCurrency').value = e
    ? e.currency
    : knownCurrency(settings.lastCurrency) ? settings.lastCurrency : settings.currency;
  updateConvertHint();
  const category = e ? e.category : CAT[settings.lastCategory] ? settings.lastCategory : 'food';
  form.querySelector(`input[name="category"][value="${category}"]`).checked = true;
  form.date.value = e ? e.date : defaultDate();
  $('#method').value = e ? e.method : METHODS.includes(settings.lastMethod) ? settings.lastMethod : 'Card';
  form.note.value = e ? e.note : '';
  $('#deleteBtn').hidden = !e;
  $('#formError').hidden = true;
  expenseDialog.showModal();
  form.amount.focus();
}

// Under the amount, shows what a foreign-currency expense is worth in the main currency.
function updateConvertHint() {
  const hint = $('#convertHint');
  const currency = $('#expCurrency').value;
  const amount = parseFloat(form.amount.value);
  if (currency === settings.currency) {
    hint.hidden = true;
    return;
  }
  hint.textContent =
    amount > 0
      ? `${currencyName(currency)} · ≈ ${fmt(convert(amount, currency, settings.currency))} at today's rate`
      : `${currencyName(currency)} · counted in ${settings.currency} in your totals`;
  hint.hidden = false;
}

form.amount.addEventListener('input', updateConvertHint);
$('#expCurrency').addEventListener('change', () => {
  updateConvertHint();
  form.amount.focus();
});

function showFormError(message) {
  const el = $('#formError');
  el.textContent = message;
  el.hidden = false;
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const amount = Math.round(parseFloat(form.amount.value) * 100) / 100;
  if (!(amount > 0)) return showFormError('Enter an amount greater than zero.');
  if (amount >= 1e10) return showFormError('That amount is too large.');
  const date = form.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showFormError('Pick a date.');
  const category = form.querySelector('input[name="category"]:checked')?.value || 'other';
  const currency = $('#expCurrency').value;
  if (!knownCurrency(currency)) return showFormError('Pick a currency.');
  const data = { amount, currency, category, date, method: $('#method').value, note: form.note.value.trim() };

  if (editingId) {
    Object.assign(expenses.find((x) => x.id === editingId), data);
    toast('Expense updated');
  } else {
    expenses.push({ id: uid(), createdAt: Date.now(), ...data });
    toast(`Added ${fmtIn(amount, currency)} for ${CAT[category].name}`);
  }
  settings.lastCategory = category;
  settings.lastMethod = data.method;
  settings.lastCurrency = currency;
  saveSettings();
  persist();

  // Show the month the expense landed in, so it never seems to disappear.
  const d = parseISO(date);
  view.year = d.getFullYear();
  view.month = d.getMonth();
  expenseDialog.close();
  render();
});

$('#deleteBtn').addEventListener('click', () => {
  const id = editingId;
  expenseDialog.close();
  deleteExpense(id);
});

function deleteExpense(id) {
  const index = expenses.findIndex((e) => e.id === id);
  if (index < 0) return;
  const [removed] = expenses.splice(index, 1);
  persist();
  render();
  toast('Expense deleted', 'Undo', () => {
    expenses.push(removed);
    persist();
    render();
  });
}

/* ---------- Settings & data ---------- */

const settingsDialog = $('#settingsDialog');

function openSettings() {
  $('#currency').value = settings.currency;
  $('#budget').value = settings.budget > 0 ? settings.budget : '';
  renderRatesInfo();
  settingsDialog.showModal();
}

// Switching the main currency re-counts every total in it, and carries the budget over at today's rate.
$('#currency').addEventListener('change', (ev) => {
  const previous = settings.currency;
  settings.currency = ev.target.value;
  if (settings.budget > 0) {
    settings.budget = Math.round(convert(settings.budget, previous, settings.currency));
    $('#budget').value = settings.budget;
  }
  saveSettings();
  renderRatesInfo();
  render();
});

function renderRatesInfo() {
  $('#budgetCurrency').textContent = settings.currency;
  const info = $('#ratesInfo');
  if (rates.updatedAt) {
    const when = new Date(rates.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    info.innerHTML = `Exchange rates from ${when}. <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates by Exchange Rate API</a>`;
  } else {
    info.textContent = 'Using approximate built-in exchange rates until today’s rates load.';
  }
}

async function refreshRates() {
  if (Date.now() - rates.fetchedAt < RATES_MAX_AGE) return;
  try {
    const res = await fetch(RATES_URL);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates || data.rates.USD !== 1) throw new Error('Bad rates');
    rates = { rates: data.rates, fetchedAt: Date.now(), updatedAt: data.time_last_update_unix * 1000 };
    save(RATES_KEY, rates);
    buildCurrencySelects();
    renderRatesInfo();
    render();
  } catch {
    // Offline or the service is down: keep the cached or built-in rates.
  }
}

$('#budget').addEventListener('input', (ev) => {
  settings.budget = Math.max(0, parseFloat(ev.target.value) || 0);
  saveSettings();
  render();
});

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheets from treating notes as formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$('#exportCsv').addEventListener('click', () => {
  if (!expenses.length) return toast('No expenses to export yet');
  const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
  const lines = [
    ['Date', 'Category', 'Amount', 'Currency', `Amount in ${settings.currency}`, 'Paid with', 'Note'],
    ...sorted.map((e) => [
      e.date,
      CAT[e.category].name,
      e.amount.toFixed(2),
      e.currency,
      toMain(e).toFixed(2),
      e.method,
      e.note,
    ]),
  ];
  download(`expenses-${isoDate(new Date())}.csv`, lines.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  toast(`Exported ${expenses.length} expenses`);
});

$('#backupJson').addEventListener('click', () => {
  const backup = {
    app: 'expense-tracker',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: { currency: settings.currency, budget: settings.budget },
    expenses,
  };
  download(`expenses-backup-${isoDate(new Date())}.json`, JSON.stringify(backup, null, 2), 'application/json');
  toast('Backup downloaded');
});

$('#restoreJson').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Older backups have one currency for everything, kept in their settings.
    const backupCurrency = knownCurrency(data.settings?.currency) ? data.settings.currency : settings.currency;
    const restored = sanitize(Array.isArray(data) ? data : data.expenses, backupCurrency);
    if (!restored.length) return toast('That file has no expenses in it');
    if (expenses.length && !confirm(`Replace your ${expenses.length} expenses with ${restored.length} from the backup?`)) return;
    expenses = restored;
    if (data.settings) {
      settings.currency = backupCurrency;
      if (+data.settings.budget >= 0) settings.budget = +data.settings.budget;
      saveSettings();
      openSettings();
    }
    persist();
    render();
    toast(`Restored ${restored.length} expenses`);
  } catch {
    toast('Could not read that file');
  }
});

$('#sampleData').addEventListener('click', () => {
  addSampleData();
  settingsDialog.close();
});

$('#clearAll').addEventListener('click', () => {
  if (!expenses.length) return toast('There is nothing to delete');
  if (!confirm(`Delete all ${expenses.length} expenses? You can undo this right after.`)) return;
  const old = expenses;
  expenses = [];
  persist();
  render();
  settingsDialog.close();
  toast('All expenses deleted', 'Undo', () => {
    expenses = old;
    persist();
    render();
  });
});

function addSampleData() {
  // Amounts are written in USD terms and scaled to the main currency; trip expenses stay in a foreign one.
  const main = settings.currency;
  const scale = main === 'USD' ? 1 : Math.max(1, Math.round(convert(1, 'USD', main)));
  const abroad = main === 'EUR' ? 'GBP' : 'EUR';
  const template = [
    [1, 'rent', 1200, 'Bank transfer', 'Monthly rent'],
    [2, 'groceries', 64.3, 'Card', 'Weekly groceries'],
    [3, 'food', 18.5, 'Card', 'Lunch with the team'],
    [4, 'transport', 32, 'Mobile wallet', 'Metro card top-up'],
    [5, 'bills', 86.4, 'Card', 'Electricity'],
    [7, 'entertainment', 15.99, 'Card', 'Streaming subscription'],
    [8, 'bills', 45, 'Card', 'Phone & internet'],
    [9, 'groceries', 52.1, 'Card', 'Weekly groceries'],
    [11, 'shopping', 79, 'Card', 'Running shoes'],
    [12, 'food', 42.75, 'Cash', 'Dinner out'],
    [14, 'health', 25, 'Card', 'Pharmacy'],
    [16, 'groceries', 58.9, 'Card', 'Weekly groceries'],
    [18, 'transport', 14.2, 'Mobile wallet', 'Taxi home'],
    [19, 'education', 29, 'Card', 'Online course'],
    [21, 'food', 9.4, 'Cash', 'Coffee & pastry'],
    [23, 'groceries', 61.2, 'Card', 'Weekly groceries'],
    [25, 'entertainment', 36, 'Card', 'Concert tickets'],
    [26, 'travel', 140, 'Card', 'Weekend train tickets', true],
    [27, 'food', 34, 'Card', 'Dinner on the trip', true],
    [28, 'other', 20, 'Cash', 'Gift for a friend'],
  ];
  const today = new Date();
  const added = [];
  for (let back = 1; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const lastDay = back === 0 ? today.getDate() : daysIn(y, m);
    template.forEach(([day, category, amount, method, note, foreign], i) => {
      if (day > lastDay) return;
      const wobble = category === 'rent' ? 1 : 0.8 + ((i * 37 + back * 17) % 40) / 100;
      added.push({
        id: uid(),
        createdAt: Date.now() + added.length,
        amount: Math.round(amount * wobble * (foreign ? 1 : scale) * 100) / 100,
        currency: foreign ? abroad : main,
        category,
        date: `${monthKey(y, m)}-${pad(day)}`,
        method,
        note,
      });
    });
  }
  expenses.push(...added);
  if (!settings.budget) settings.budget = 2400 * scale;
  saveSettings();
  persist();
  view.year = today.getFullYear();
  view.month = today.getMonth();
  render();
  toast(`Added ${added.length} sample expenses`, 'Undo', () => {
    const ids = new Set(added.map((e) => e.id));
    expenses = expenses.filter((e) => !ids.has(e.id));
    persist();
    render();
  });
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(message, actionLabel, action) {
  const el = $('#toast');
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      action();
      hideToast();
    });
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  $('#toast').classList.remove('show');
}

/* ---------- Theme ---------- */

function applyTheme() {
  if (settings.theme) root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
}

$('#themeBtn').addEventListener('click', () => {
  const dark = settings.theme ? settings.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  settings.theme = dark ? 'light' : 'dark';
  saveSettings();
  applyTheme();
});

/* ---------- Events ---------- */

function shiftMonth(delta) {
  const d = new Date(view.year, view.month + delta, 1);
  view.year = d.getFullYear();
  view.month = d.getMonth();
  render();
}

$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
$('#monthLabel').addEventListener('click', () => {
  const t = new Date();
  view.year = t.getFullYear();
  view.month = t.getMonth();
  render();
});
$('#addBtn').addEventListener('click', () => openExpense());
$('#settingsBtn').addEventListener('click', openSettings);

$('#search').addEventListener('input', (ev) => {
  filters.q = ev.target.value;
  render();
});
$('#catFilter').addEventListener('change', (ev) => {
  filters.cat = ev.target.value;
  render();
});
$('#sortBy').addEventListener('change', (ev) => {
  filters.sort = ev.target.value;
  render();
});

$('#legend').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-cat]');
  if (!btn) return;
  filters.cat = filters.cat === btn.dataset.cat ? 'all' : btn.dataset.cat;
  render();
});

$('#list').addEventListener('click', (ev) => {
  const row = ev.target.closest('.tx');
  if (row) openExpense(row.dataset.id);
});

document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-open-settings]')) openSettings();
  if (ev.target.closest('[data-close]')) ev.target.closest('dialog').close();
});

// Clicking the dimmed backdrop closes a dialog.
for (const dialog of [expenseDialog, settingsDialog]) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
}

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (ev.target.closest('input, select, textarea')) return;
  if (ev.key === 'n' || ev.key === 'N') {
    ev.preventDefault();
    openExpense();
  } else if (ev.key === 'ArrowLeft') {
    shiftMonth(-1);
  } else if (ev.key === 'ArrowRight') {
    shiftMonth(1);
  }
});

/* ---------- Start ---------- */

buildForm();
applyTheme();
render();
refreshRates();
