'use strict';
/* Albion Flip Helper (PWA) — спред на рынке одного города.
   Ордер на покупку (лучший+1) -> ордер на продажу (лучший-1).
   Данные: Albion Online Data Project. В игре программа ничего не делает. */

const SERVERS = {
  'Европа': 'europe.albion-online-data.com',
  'Америка (west)': 'west.albion-online-data.com',
  'Азия (east)': 'east.albion-online-data.com',
};
const CITIES = ['Caerleon', 'Bridgewatch', 'Martlock', 'Lymhurst', 'Fort Sterling', 'Thetford', 'Brecilien'];
const CATEGORIES = {
  'Всё': [],
  'Оружие': ['MAIN_', '2H_'],
  'Броня (тело)': ['ARMOR_'],
  'Шлемы': ['HEAD_'],
  'Обувь': ['SHOES_'],
  'Сумки и плащи': ['BAG', 'CAPEITEM'],
  // '^' = id (после префикса тира) должен начинаться с ключа, иначе _CLOTH/_LEATHER цепляют броню
  'Ресурсы (сырьё)': ['^WOOD', '^ROCK', '^ORE', '^FIBER', '^HIDE'],
  'Ресурсы (обработанные)': ['^PLANKS', '^STONEBLOCK', '^METALBAR', '^CLOTH', '^LEATHER'],
  'Еда': ['MEAL_'],
  'Зелья': ['POTION_'],
};
const ITEMS_URL = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.txt';
const NAMES_URL = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json';
const NAMES_KEY = 'https://afh.local/names-ru-v1.json';   // фиктивный адрес для кэша компактной карты названий
const NAMES_TTL = 30 * 86400000;
const SETUP_FEE = 0.025;   // сбор за создание ордера (покупка и продажа)
const BATCH = 100;         // предметов на запрос цен
const BATCH_H = 50;        // предметов на запрос истории
const PAUSE = 450;         // мс между запросами (лимит API ~180/мин)

/* ---------- чистая логика (тестируется в node) ---------- */

function calcFlip(buyMax, sellMin, premium) {
  const tax = premium ? 0.04 : 0.08;
  const myBuy = buyMax + 1;
  const mySell = sellMin - 1;
  const cost = myBuy * (1 + SETUP_FEE);
  const revenue = mySell * (1 - tax - SETUP_FEE);
  const profit = revenue - cost;
  const roi = cost ? (profit / cost) * 100 : 0;
  return { myBuy, mySell, profit, roi };
}

function tierEnchant(id) {
  const t = /^T(\d)_/.exec(id);
  const e = /@(\d)$/.exec(id);
  return [t ? +t[1] : 0, e ? +e[1] : 0];
}

function ageMin(nowMs, ...dates) {
  let max = 0;
  for (const d of dates) {
    if (!d || d.startsWith('0001')) return null;
    const t = Date.parse(d.slice(0, 19) + 'Z');
    if (isNaN(t)) return null;
    max = Math.max(max, (nowMs - t) / 60000);
  }
  return max;
}

function parseItems(text) {
  const items = {};
  const rx = /^\s*\d+:\s*(\S+)\s*:\s*(.*)$/;
  for (const line of text.split('\n')) {
    const m = rx.exec(line);
    if (m) items[m[1]] = m[2].trim() || m[1];
  }
  return items;
}

function buildIdList(items, p) {
  const kws = CATEGORIES[p.cat] || [];
  const ids = [];
  for (const id of Object.keys(items)) {
    const [t, e] = tierEnchant(id);
    if (t < p.tmin || t > p.tmax || e > p.emax) continue;
    if (kws.length) {
      const body = id.replace(/^T\d_/, '');
      if (!kws.some(k => k[0] === '^' ? body.startsWith(k.slice(1)) : id.includes(k))) continue;
    }
    ids.push(id);
  }
  return ids;
}

/* Разбор огромного formatted/items.json без загрузки целиком в память:
   принимает текст кусками (push), на выходе компактная карта {UniqueName: русское название}. */
function makeNameExtractor() {
  const map = {};
  let buf = '';
  const unq = s => { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
  function take(id, seg) {
    const blk = /"LocalizedNames"\s*:\s*\{([^}]*)\}/.exec(seg);
    if (!blk) return;
    const ru = /"RU-RU"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(blk[1]);
    const en = /"EN-US"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(blk[1]);
    const v = (ru && ru[1]) || (en && en[1]);
    if (v) map[id] = unq(v);
  }
  return {
    push(chunk) {
      buf += chunk;
      const rx = /"UniqueName"\s*:\s*"([^"]+)"/g;
      let last = 0, m;
      while ((m = rx.exec(buf))) { take(m[1], buf.slice(last, m.index)); last = rx.lastIndex; }
      buf = buf.slice(last);
    },
    result() { return map; },
  };
}

function localizeItems(items, ru) {
  for (const id of Object.keys(items)) {
    items[id] = ru[id] || ru[id.replace(/@\d$/, '')] || items[id];
  }
  return items;
}

function processPrices(rows, items, p, nowMs, st = {}) {
  const inc = k => { st[k] = (st[k] || 0) + 1; };
  const out = [];
  for (const r of rows) {
    inc('rows');
    const buy = r.buy_price_max || 0, sell = r.sell_price_min || 0;
    if (buy <= 0 || sell <= 0) {
      inc(buy <= 0 && sell <= 0 ? 'noData' : sell <= 0 ? 'noSell' : 'noBuy');
      continue;
    }
    const f = calcFlip(buy, sell, p.premium);
    if (sell - buy < 3 || f.profit <= 0) { inc('loss'); continue; }
    const age = ageMin(nowMs, r.buy_price_max_date, r.sell_price_min_date);
    if (age === null || age > p.maxage) { inc('stale'); continue; }
    if (f.roi < p.minroi) { inc('roiLow'); continue; }
    if (f.roi > p.maxroi) { inc('roiHigh'); continue; }
    const qty = Math.floor(p.budget / (f.myBuy * (1 + SETUP_FEE)));
    if (qty < 1) { inc('budget'); continue; }
    const [t, e] = tierEnchant(r.item_id);
    out.push({
      id: r.item_id, name: items[r.item_id] || r.item_id, tier: `T${t}.${e}`,
      buyNow: buy, sellNow: sell, myBuy: f.myBuy, mySell: f.mySell,
      profit: Math.round(f.profit), roi: Math.round(f.roi * 10) / 10,
      qty, vol: 0, total: Math.round(f.profit * qty), age: Math.round(age),
    });
  }
  return out;
}

function funnelText(st, p) {
  const n = k => st[k] || 0;
  return [
    `Предметов под фильтры: ${n('items')}, цены пришли по: ${n('rows')}`,
    `Нет ни покупки, ни продажи (пусто): ${n('noData')}`,
    `Есть покупка, нет продажи: ${n('noSell')}`,
    `Есть продажа, нет покупки: ${n('noBuy')}`,
    `Спред слишком мал (убыток после налога): ${n('loss')}`,
    `Прибыльно, но данные старше ${p.maxage} мин: ${n('stale')}`,
    `ROI ниже ${p.minroi}%: ${n('roiLow')}, выше ${p.maxroi}%: ${n('roiHigh')}`,
    `Не хватило бюджета: ${n('budget')}`,
    `Отсеяно по объёму (меньше ${p.minvol} за 24ч): ${n('lowVol')}`,
    `Не загрузилось пачек: цены ${n('failP')}, объёмы ${n('failH')}`,
  ].join('\n');
}

function sumVolumes(entries, vols, nowMs) {
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const e of entries) {
    if (!(e.item_id in vols)) continue;
    let s = 0;
    for (const pt of e.data || []) {
      const ts = Date.parse((pt.timestamp || '').slice(0, 19) + 'Z');
      if (!isNaN(ts) && ts >= cutoff) s += pt.item_count || 0;
    }
    vols[e.item_id] = s;
  }
  return vols;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

if (typeof module !== 'undefined') {
  module.exports = { calcFlip, tierEnchant, ageMin, parseItems, buildIdList, processPrices, sumVolumes, funnelText, makeNameExtractor, localizeItems, CATEGORIES };
}

/* ---------- интерфейс ---------- */

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id) || document.createElement('input');  // страховка, если html и js из разных версий
  const FIELDS = ['server', 'city', 'cat', 'budget', 'tmin', 'tmax', 'emax', 'maxage', 'minroi', 'maxroi', 'minvol', 'premium', 'sort'];
  let items = null, namesRu = true, stop = false, running = false, results = [];

  function fillSelect(el, values) {
    el.innerHTML = values.map(v => `<option>${v}</option>`).join('');
  }
  fillSelect($('server'), Object.keys(SERVERS));
  fillSelect($('city'), CITIES);
  fillSelect($('cat'), Object.keys(CATEGORIES));

  const defaults = { server: 'Европа', city: 'Caerleon', cat: 'Оружие', budget: '1000000', tmin: '4', tmax: '6',
    emax: '0', maxage: '60', minroi: '5', maxroi: '150', minvol: '10', premium: true, sort: 'total' };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('afh-settings') || '{}'); } catch (e) { /* ignore */ }
  for (const f of FIELDS) {
    const v = f in saved ? saved[f] : defaults[f];
    if ($(f).type === 'checkbox') $(f).checked = !!v; else $(f).value = v;
  }
  function saveSettings() {
    const o = {};
    for (const f of FIELDS) o[f] = $(f).type === 'checkbox' ? $(f).checked : $(f).value;
    try { localStorage.setItem('afh-settings', JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  for (const f of FIELDS) $(f).addEventListener('change', saveSettings);
  $('sort').addEventListener('change', () => render());

  function readParams() {
    const num = (id, d) => { const v = parseFloat(String($(id).value).replace(/\s/g, '')); return isNaN(v) ? d : v; };
    return {
      server: SERVERS[$('server').value], city: $('city').value, cat: $('cat').value,
      budget: num('budget', 0), tmin: num('tmin', 1), tmax: num('tmax', 8), emax: num('emax', 0),
      maxage: num('maxage', 60), minroi: num('minroi', 0), maxroi: num('maxroi', 1e9),
      minvol: num('minvol', 0), premium: $('premium').checked,
    };
  }

  function setStatus(t) { $('status').textContent = t; }
  function setProgress(n, total) { const pb = $('pb'); pb.max = total; pb.value = n; }

  async function loadNamesRu() {
    const cache = await caches.open('afh-data');
    const stamp = +localStorage.getItem('afh-names-ts') || 0;
    const old = await cache.match(NAMES_KEY);
    if (old && Date.now() - stamp < NAMES_TTL) return await old.json();
    try {
      const r = await fetch(NAMES_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ex = makeNameExtractor();
      if (r.body) {
        const reader = r.body.getReader(), dec = new TextDecoder();
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          ex.push(dec.decode(value, { stream: true }));
          setStatus(`Загружаю русские названия (один раз в 30 дней): ${(bytes / 1048576).toFixed(0)} МБ…`);
        }
      } else {
        ex.push(await r.text());
      }
      const map = ex.result();
      if (Object.keys(map).length < 100) throw new Error('пустой список названий');
      await cache.put(NAMES_KEY, new Response(JSON.stringify(map), { headers: { 'Content-Type': 'application/json' } }));
      localStorage.setItem('afh-names-ts', String(Date.now()));
      return map;
    } catch (err) {
      return old ? await old.json() : null;   // нет сети — берём старый кэш, иначе остаются английские названия
    }
  }

  async function loadItems() {
    if (items) return items;
    const cache = await caches.open('afh-data');
    const stamp = +localStorage.getItem('afh-items-ts') || 0;
    let resp = await cache.match(ITEMS_URL);
    if (!resp || Date.now() - stamp > 7 * 86400000) {
      try {
        const fresh = await fetch(ITEMS_URL);
        if (!fresh.ok) throw new Error('HTTP ' + fresh.status);
        await cache.put(ITEMS_URL, fresh.clone());
        localStorage.setItem('afh-items-ts', String(Date.now()));
        resp = fresh;
      } catch (err) {
        if (!resp) throw err;       // нет сети, но есть старый кэш — используем его
      }
    }
    const list = parseItems(await resp.text());
    setStatus('Загружаю русские названия…');
    let ru = null;
    try { ru = await loadNamesRu(); } catch (e) { /* остаются английские */ }
    namesRu = !!ru;
    items = ru ? localizeItems(list, ru) : list;
    return items;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  const fmt = n => Number(n).toLocaleString('ru-RU');

  function render() {
    const key = $('sort').value;
    const arr = results.slice().sort((a, b) => b[key] - a[key]);
    $('list').innerHTML = arr.map(r => `
      <article class="card">
        <header><b>${esc(r.name)}</b><span class="tier">${esc(r.tier)}</span></header>
        <div class="grid">
          <div><small>Сейчас: покупка / продажа</small>${fmt(r.buyNow)} / ${fmt(r.sellNow)}</div>
          <div><small>Ставим: покупка → продажа</small><b>${fmt(r.myBuy)} → ${fmt(r.mySell)}</b></div>
          <div><small>Прибыль с шт. · ROI</small>${fmt(r.profit)} · ${r.roi}%</div>
          <div><small>Продано за 24ч</small>${fmt(r.vol)}</div>
          <div><small>Штук (бюджет/объём)</small>${fmt(r.qty)}</div>
          <div><small>Итого прибыль</small><b class="gain">+${fmt(r.total)}</b></div>
        </div>
        <footer>данным ${r.age} мин</footer>
      </article>`).join('');
  }

  async function scan() {
    if (running) return;
    const p = readParams();
    running = true; stop = false; results = []; render();
    $('go').disabled = true; $('stop').disabled = false; $('filters').open = false;
    try {
      setStatus('Загружаю список предметов…');
      await loadItems();
      const ids = buildIdList(items, p);
      if (!ids.length) { setStatus('Под фильтры ничего не подошло.'); return; }
      const note = ` (предметов: ${ids.length})`;
      const st = { items: ids.length };

      const rows = [];
      const batches = [];
      for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
      for (let n = 0; n < batches.length && !stop; n++) {
        setStatus(`Цены: запрос ${n + 1}/${batches.length}${note}`);
        setProgress(n + 1, batches.length);
        try {
          rows.push(...await getJSON(`https://${p.server}/api/v2/stats/prices/${batches[n].join(',')}.json?locations=${encodeURIComponent(p.city)}&qualities=1`));
        } catch (err) { st.failP = (st.failP || 0) + 1; }
        await sleep(PAUSE);
      }
      const cands = processPrices(rows, items, p, Date.now(), st);
      if (!cands.length || stop) { setStatus((stop ? 'Остановлено.' : 'Под фильтры по цене ничего не подошло.') + '\n' + funnelText(st, p)); return; }

      const vols = Object.fromEntries(cands.map(c => [c.id, 0]));
      const cids = cands.map(c => c.id);
      const hb = [];
      for (let i = 0; i < cids.length; i += BATCH_H) hb.push(cids.slice(i, i + BATCH_H));
      for (let n = 0; n < hb.length && !stop; n++) {
        setStatus(`Объёмы за 24ч: запрос ${n + 1}/${hb.length} (кандидатов ${cands.length})`);
        setProgress(n + 1, hb.length);
        try {
          sumVolumes(await getJSON(`https://${p.server}/api/v2/stats/history/${hb[n].join(',')}?locations=${encodeURIComponent(p.city)}&time-scale=1&qualities=1`), vols, Date.now());
        } catch (err) { st.failH = (st.failH || 0) + 1; }
        await sleep(PAUSE);
      }
      results = [];
      for (const c of cands) {
        const v = vols[c.id] || 0;
        if (v < p.minvol) { st.lowVol = (st.lowVol || 0) + 1; continue; }
        c.vol = v; c.qty = Math.min(c.qty, v); c.total = Math.round(c.profit * c.qty);
        results.push(c);
      }
      render();
      setStatus(`Готово: найдено ${results.length}.` + (namesRu ? '' : ' Русские названия не загрузились, показаны английские.') + '\n' + funnelText(st, p));
    } catch (err) {
      setStatus('Ошибка: ' + err.message);
    } finally {
      running = false; $('go').disabled = false; $('stop').disabled = true;
    }
  }

  $('go').addEventListener('click', scan);
  $('stop').addEventListener('click', () => { stop = true; });
  $('stop').disabled = true;
  $('refresh').addEventListener('click', async () => {
    localStorage.removeItem('afh-items-ts'); localStorage.removeItem('afh-names-ts'); items = null;
    try { const c = await caches.open('afh-data'); await c.delete(ITEMS_URL); await c.delete(NAMES_KEY); } catch (e) { /* ignore */ }
    setStatus('Список предметов обновится при следующем скане.');
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
