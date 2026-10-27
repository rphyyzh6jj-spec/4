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

/* ---------- маршруты между городами ---------- */

/* ОЦЕНКА риска и длины пути (1..3), а не данные с карты. Правится здесь.
   Известно из гайдов: вокруг Caerleon красные зоны (полный лут), между королевскими городами дороги безопаснее.
   Остальное (особенно Brecilien и длина путей) — грубое допущение.
   Свои значения: ROUTE_OVERRIDES['Bridgewatch|Martlock'] = { risk: 1, travel: 1 }  (два города по алфавиту) */
const ROUTE_OVERRIDES = {};
function routeMeta(a, b) {
  const key = [a, b].sort().join('|');
  if (ROUTE_OVERRIDES[key]) return ROUTE_OVERRIDES[key];
  if (a === 'Caerleon' || b === 'Caerleon') return { risk: 3, travel: 1 };
  if (a === 'Brecilien' || b === 'Brecilien') return { risk: 2, travel: 3 };
  return { risk: 1, travel: 2 };
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

/* Покупаем по ордеру на продажу в городе A (без сбора), продаём в городе B:
   instant — сразу в чужую заявку на покупку (только налог), order — своим ордером (налог + сбор 2.5%). */
function findOpps(rows, items, p, nowMs, st = {}) {
  const inc = k => { st[k] = (st[k] || 0) + 1; };
  const tax = p.premium ? 0.04 : 0.08;
  const byItem = {};
  for (const r of rows) {
    const c = CITIES.find(x => norm(x) === norm(r.city));
    if (c) (byItem[r.item_id] = byItem[r.item_id] || {})[c] = r;
  }
  const out = [];
  for (const [id, cities] of Object.entries(byItem)) {
    for (const a of CITIES) {
      if (p.from && a !== p.from) continue;   // режим «из выбранного города»
      const ra = cities[a];
      const buy = (ra && ra.sell_price_min) || 0;
      if (buy <= 0) continue;
      for (const b of CITIES) {
        if (b === a || !cities[b]) continue;
        const rb = cities[b];
        const bBuy = rb.buy_price_max || 0, bSell = rb.sell_price_min || 0;
        if (bBuy <= 0 && bSell <= 0) continue;
        inc('pairs');
        const cand = [];
        if (bBuy > 0) cand.push({ mode: 'instant', price: bBuy, profit: bBuy * (1 - tax) - buy, date: rb.buy_price_max_date });
        if (bSell > 1) cand.push({ mode: 'order', price: bSell - 1, profit: (bSell - 1) * (1 - tax - SETUP_FEE) - buy, date: rb.sell_price_min_date });
        const prof = cand.filter(m => m.profit > 0);
        if (!prof.length) { inc('loss'); continue; }
        const fresh = [];
        for (const m of prof) {
          const age = ageMin(nowMs, ra.sell_price_min_date, m.date);
          if (age !== null && age <= p.maxage) { m.age = age; fresh.push(m); }
        }
        if (!fresh.length) { inc('stale'); continue; }
        const ok = [];
        for (const m of fresh) {
          m.roi = (m.profit / buy) * 100;
          if (m.roi >= p.minroi && m.roi <= p.maxroi) ok.push(m);
        }
        if (!ok.length) { inc(fresh.every(m => m.roi < p.minroi) ? 'roiLow' : 'roiHigh'); continue; }
        inc('ok');
        const [t, e] = tierEnchant(id);
        const modes = {};
        for (const m of ok) modes[m.mode] = { price: m.price, profit: m.profit, roi: m.roi, age: Math.round(m.age) };
        out.push({ id, name: items[id] || id, tier: `T${t}.${e}`, from: a, to: b, buy, modes });
      }
    }
  }
  return out;
}

function pickMode(o, variant) {
  const I = o.modes.instant, O = o.modes.order;
  if (variant === 'instant') return I ? { mode: 'instant', ...I } : null;
  if (I && (!O || I.profit >= O.profit)) return { mode: 'instant', ...I };
  return O ? { mode: 'order', ...O } : null;
}

/* Чтобы не запрашивать объёмы по десяткам тысяч пар: по каждому маршруту берём лучшие perRoute вариантов */
function candidateOpps(opps, p, perRoute = 40) {
  const groups = {};
  for (const o of opps) (groups[o.from + '|' + o.to] = groups[o.from + '|' + o.to] || []).push(o);
  const out = [];
  for (const g of Object.values(groups)) {
    const score = o => Math.max(...Object.values(o.modes).map(m => m.profit)) * Math.max(1, Math.floor(p.budget / o.buy));
    g.sort((x, y) => score(y) - score(x));
    out.push(...g.slice(0, perRoute));
  }
  return out;
}

function sumVolumesByCity(entries, vols, nowMs) {
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const e of entries) {
    let s = 0;
    for (const pt of e.data || []) {
      const ts = Date.parse((pt.timestamp || '').slice(0, 19) + 'Z');
      if (!isNaN(ts) && ts >= cutoff) s += pt.item_count || 0;
    }
    const k = e.item_id + '|' + norm(e.location);
    vols[k] = (vols[k] || 0) + s;
  }
  return vols;
}

function buildBasket(group, vols, p, variant, st) {
  const lines = [];
  for (const o of group) {
    const m = pickMode(o, variant);
    if (!m) continue;
    const vol = vols[o.id + '|' + norm(o.to)] || 0;
    if (vol < p.minvol) { if (st && variant === 'best') st.lowVol = (st.lowVol || 0) + 1; continue; }
    const maxQty = Math.min(Math.floor(p.budget / o.buy), vol);
    if (maxQty < 1) continue;
    lines.push({ o, m, vol, maxQty, ratio: m.profit / o.buy });
  }
  lines.sort((x, y) => y.ratio - x.ratio);
  let left = p.budget, cost = 0, profit = 0;
  const items = [];
  for (const l of lines) {
    const q = Math.min(l.maxQty, Math.floor(left / l.o.buy));
    if (q < 1) continue;
    left -= q * l.o.buy; cost += q * l.o.buy; profit += q * l.m.profit;
    items.push({ id: l.o.id, name: l.o.name, tier: l.o.tier, buy: l.o.buy, sell: l.m.price, mode: l.m.mode,
      qty: q, profit: Math.round(l.m.profit), roi: Math.round(l.m.roi * 10) / 10, total: Math.round(l.m.profit * q), vol: l.vol });
  }
  items.sort((x, y) => y.total - x.total);
  return { items, cost: Math.round(cost), profit: Math.round(profit), count: items.length };
}

function buildRoutes(opps, vols, p, st = {}) {
  const groups = {};
  for (const o of opps) (groups[o.from + '|' + o.to] = groups[o.from + '|' + o.to] || []).push(o);
  const routes = [];
  for (const g of Object.values(groups)) {
    const { from, to } = g[0];
    const best = buildBasket(g, vols, p, 'best', st);
    if (!best.count) continue;
    const instant = buildBasket(g, vols, p, 'instant', st);
    routes.push({ from, to, ...routeMeta(from, to), best, instant });
  }
  return routes;
}

function rankRoutes(routes, n = 10) {
  const good = routes.filter(r => r.best.profit > 0);
  return {
    profit: good.slice().sort((a, b) => b.best.profit - a.best.profit).slice(0, n),
    safe: good.slice().sort((a, b) => a.risk - b.risk || b.best.profit - a.best.profit).slice(0, n),
    fast: routes.filter(r => r.instant.profit > 0).sort((a, b) => a.travel - b.travel || b.instant.profit - a.instant.profit).slice(0, n),
  };
}

function funnelRoutesText(st, p) {
  const n = k => st[k] || 0;
  return [
    `Предметов под фильтры: ${n('items')}, пар «город → город» с ценами: ${n('pairs')}`,
    `Нет прибыли после налога: ${n('loss')}`,
    `Прибыльно, но данные старше ${p.maxage} мин: ${n('stale')}`,
    `ROI ниже ${p.minroi}%: ${n('roiLow')}, выше ${p.maxroi}%: ${n('roiHigh')}`,
    `Подошло по ценам: ${n('ok')}`,
    `Отсеяно по объёму (меньше ${p.minvol} за 24ч в городе продажи): ${n('lowVol')}`,
    `Не загрузилось пачек: цены ${n('failP')}, объёмы ${n('failH')}`,
  ].join('\n');
}

/* ---------- крафт ---------- */
const RECIPES_URLS = [
  'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/items.json',
  'https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/items.json',
];
const RECIPES_KEY = 'https://afh.local/recipes-v1.json';
const RECIPES_TTL = 30 * 86400000;
const MIN_RECIPES = 50;   // если разобрали меньше — считаем, что формат файла не тот
/* Эти компоненты при крафте не возвращаются (артефакты, руны, души, реликвии и т.п.) */
const NO_RETURN = /ARTEFACT|ARTIFACT|RUNE|SOUL|RELIC|SHARD|QUESTITEM|CREST|JOURNAL|_CAPE$/;

const asArr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

function resId(c) {
  let id = c['@uniquename'];
  const lvl = c['@enchantmentlevel'];
  if (!id) return null;
  if (id.includes('@')) return id;
  if (lvl && +lvl > 0) return `${id}@${lvl}`;
  const m = /_LEVEL(\d)$/.exec(id);
  return m ? `${id}@${m[1]}` : id;
}

function parseReqs(cr, fallbackAmount) {
  for (const r of asArr(cr)) {
    if (!r || typeof r !== 'object') continue;
    const res = asArr(r.craftresource).map(c => [resId(c), +c['@count']]).filter(([id, n]) => id && n > 0);
    if (res.length) return { r: res, a: +(r['@amountcrafted'] || fallbackAmount || 1) || 1 };
  }
  return null;
}

/* Ищем по всему файлу объекты с @uniquename и craftingrequirements — не зависит от того, в каком
   разделе (simpleitem / equipmentitem / weapon…) лежит предмет. Зачарованные варианты — id@N. */
function extractRecipes(root) {
  const out = {};
  (function walk(node) {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== 'object') return;
    const id = node['@uniquename'];
    if (typeof id === 'string' && node.craftingrequirements) {
      const rec = parseReqs(node.craftingrequirements, node['@amountcrafted']);
      if (rec) out[id] = rec;
      for (const en of asArr(node.enchantments && node.enchantments.enchantment)) {
        const lvl = en && en['@enchantmentlevel'];
        if (lvl && en.craftingrequirements) {
          const r2 = parseReqs(en.craftingrequirements, node['@amountcrafted']);
          if (r2) out[`${id}@${lvl}`] = r2;
        }
      }
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') walk(node[k]);
  })(root);
  return out;
}

function indexPrices(rows) {
  const P = {};
  for (const r of rows) (P[r.item_id] = P[r.item_id] || {})[norm(r.city)] = r;
  return P;
}

/* Компоненты покупаем в городе A, готовое продаём в городе B.
   Возврат ресурсов (rrr %) снижает стоимость возвращаемых компонентов; плата станции — % от стоимости ресурсов. */
function evalCrafts(ids, recipes, rows, items, p, nowMs, st = {}) {
  const inc = k => { st[k] = (st[k] || 0) + 1; };
  const P = indexPrices(rows);
  const tax = p.premium ? 0.04 : 0.08;
  const ageOf = d => ageMin(nowMs, d, d);
  const out = [];
  for (const id of ids) {
    const rec = recipes[id];
    if (!rec) continue;
    const fr = P[id] && P[id][norm(p.sellCity)];
    const opts = [];
    if (fr && fr.buy_price_max > 0) opts.push({ mode: 'instant', price: fr.buy_price_max, net: fr.buy_price_max * (1 - tax), date: fr.buy_price_max_date });
    if (fr && fr.sell_price_min > 1) opts.push({ mode: 'order', price: fr.sell_price_min - 1, net: (fr.sell_price_min - 1) * (1 - tax - SETUP_FEE), date: fr.sell_price_min_date });
    const allowed = p.sellMode === 'best' ? opts : opts.filter(o => o.mode === p.sellMode);
    if (!allowed.length) { inc('noSell'); continue; }

    let raw = 0, net = 0, missing = false, compAge = 0, compStale = false;
    const comps = [];
    for (const [rid, count] of rec.r) {
      const cr = P[rid] && P[rid][norm(p.buyCity)];
      let price = 0, date = null;
      if (cr) {
        if (p.buyMode === 'order') { price = cr.buy_price_max > 0 ? cr.buy_price_max + 1 : 0; date = cr.buy_price_max_date; }
        else { price = cr.sell_price_min || 0; date = cr.sell_price_min_date; }
      }
      if (!(price > 0)) { missing = true; break; }
      const age = ageOf(date);
      if (age === null) compStale = true; else compAge = Math.max(compAge, age);
      const returnable = !NO_RETURN.test(rid);
      raw += count * price;
      net += count * price * (returnable ? 1 - p.rrr / 100 : 1);
      comps.push({ id: rid, name: items[rid] || rid, count, price, returnable });
    }
    if (missing) { inc('noComp'); continue; }
    if (p.buyMode === 'order') net *= 1 + SETUP_FEE;
    net += raw * (p.fee || 0) / 100;
    const unitCost = net / rec.a;

    const profitable = allowed.filter(o => o.net > unitCost);
    if (!profitable.length) { inc('loss'); continue; }
    const fresh = [];
    for (const o of profitable) {
      const a = ageOf(o.date);
      if (!compStale && a !== null && Math.max(a, compAge) <= p.maxage) { o.age = Math.max(a, compAge); fresh.push(o); }
    }
    if (!fresh.length) { inc('stale'); continue; }
    fresh.sort((x, y) => y.net - x.net);
    const o = fresh[0];
    const profit = o.net - unitCost;
    const roi = profit / unitCost * 100;
    if (roi < p.minroi) { inc('roiLow'); continue; }
    if (roi > p.maxroi) { inc('roiHigh'); continue; }
    inc('ok');
    const [t, e] = tierEnchant(id);
    out.push({ id, name: items[id] || id, tier: `T${t}.${e}`, cost: Math.round(unitCost), sell: o.price, mode: o.mode,
      profit: Math.round(profit), roi: Math.round(roi * 10) / 10, comps, amount: rec.a, age: Math.round(o.age), vol: 0 });
  }
  return out;
}

function craftFunnelText(st, p) {
  const n = k => st[k] || 0;
  return [
    `Предметов под фильтры: ${n('items')}, с рецептом: ${n('items') - n('noRecipe')}`,
    `Нет цены готового в ${p.sellCity}: ${n('noSell')}`,
    `Нет цены компонента в ${p.buyCity}: ${n('noComp')}`,
    `Убыточно: ${n('loss')}`,
    `Прибыльно, но данные старше ${p.maxage} мин: ${n('stale')}`,
    `ROI ниже ${p.minroi}%: ${n('roiLow')}, выше ${p.maxroi}%: ${n('roiHigh')}`,
    `Отсеяно по объёму (меньше ${p.minvol} за 24ч): ${n('lowVol')}`,
    `Не загрузилось пачек: цены ${n('failP')}, объёмы ${n('failH')}`,
  ].join('\n');
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
  module.exports = { calcFlip, tierEnchant, ageMin, parseItems, buildIdList, processPrices, sumVolumes, funnelText, makeNameExtractor, localizeItems, routeMeta, findOpps, candidateOpps, sumVolumesByCity, buildRoutes, rankRoutes, funnelRoutesText, extractRecipes, evalCrafts, craftFunnelText, resId, CITIES, CATEGORIES };
}

/* ---------- интерфейс ---------- */

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id) || document.createElement('input');  // страховка, если html и js из разных версий
  const FIELDS = ['server', 'city', 'cat', 'budget', 'tmin', 'tmax', 'emax', 'maxage', 'minroi', 'maxroi', 'minvol', 'premium', 'sort',
    'cserver', 'ctier', 'cbuy', 'csell', 'ccat', 'cench', 'crrr', 'cfee', 'cbuymode', 'csellmode', 'cmaxage', 'cminvol', 'cminroi', 'cmaxroi', 'cpremium', 'csort'];
  let items = null, namesRu = true, stop = false, running = false, results = [];
  let view = 'single', tab = 'profit', ranked = null;
  const TABS = [['profit', 'Выгодные'], ['safe', 'Безопасные'], ['fast', 'Быстрые']];
  const HINTS = {
    profit: 'Больше всего прибыли за один рейс. Продажа сразу в чужую заявку или своим ордером — что выгоднее.',
    safe: 'Сначала маршруты с самым низким риском (без красных зон), внутри — по прибыли.',
    fast: 'Короткий путь и продажа сразу в чужую заявку, без ожидания, пока купят твой ордер.',
  };
  const RISK_L = ['', 'низкий', 'средний', 'высокий'], TRAVEL_L = ['', 'короткий', 'средний', 'долгий'];
  let page = 'flip', recipes = null, cresults = [];
  function applyPage() {
    const f = page === 'flip';
    $('filters').hidden = !f; $('list').hidden = !f;
    $('sortrow').hidden = !f || view === 'routes';
    $('tabs').hidden = !f || view !== 'routes';
    $('go').hidden = !f; $('route').hidden = !f;
    $('cfilters').hidden = f; $('clist').hidden = f; $('csortrow').hidden = f; $('craft').hidden = f;
    $('pgFlip').className = f ? 'on' : ''; $('pgCraft').className = f ? '' : 'on';
  }
  function setView(v) { view = v; applyPage(); }

  function fillSelect(el, values) {
    el.innerHTML = values.map(v => `<option>${v}</option>`).join('');
  }
  fillSelect($('server'), Object.keys(SERVERS));
  fillSelect($('city'), CITIES);
  fillSelect($('cat'), Object.keys(CATEGORIES));
  fillSelect($('cserver'), Object.keys(SERVERS));
  fillSelect($('ctier'), ['1', '2', '3', '4', '5', '6', '7', '8']);
  fillSelect($('cench'), ['0', '1', '2', '3', '4']);
  fillSelect($('cbuy'), CITIES);
  fillSelect($('csell'), CITIES);
  fillSelect($('ccat'), ['Оружие', 'Броня (тело)', 'Шлемы', 'Обувь', 'Сумки и плащи', 'Ресурсы (обработанные)', 'Еда', 'Зелья', 'Всё']);

  const defaults = { server: 'Европа', city: 'Caerleon', cat: 'Оружие', budget: '1000000', tmin: '4', tmax: '6',
    emax: '0', maxage: '60', minroi: '5', maxroi: '150', minvol: '10', premium: true, sort: 'total',
    cserver: 'Европа', ctier: '4', cbuy: 'Bridgewatch', csell: 'Caerleon', ccat: 'Оружие', cench: '0', crrr: '15.2', cfee: '0',
    cbuymode: 'instant', csellmode: 'best', cmaxage: '180', cminvol: '5', cminroi: '5', cmaxroi: '300', cpremium: true, csort: 'profit' };
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

  function renderRoutes() {
    $('tabs').innerHTML = TABS.map(([k, t]) => `<button type="button" data-tab="${k}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('');
    const arr = ranked ? ranked[tab] : [];
    const card = r => {
      const b = tab === 'fast' ? r.instant : r.best;
      const lines = b.items.slice(0, 5).map(i => `
        <div class="it"><b>${esc(i.name)}</b> <span class="tier">${esc(i.tier)}</span><br>
        <small>${fmt(i.buy)} → ${fmt(i.sell)} (${i.mode === 'instant' ? 'сразу в заявку' : 'своим ордером'}) · ${fmt(i.qty)} шт · <span class="gain">+${fmt(i.total)}</span></small></div>`).join('');
      return `<article class="card">
        <header><b>${esc(r.from)} → ${esc(r.to)}</b><span class="gain"><b>+${fmt(b.profit)}</b></span></header>
        <div class="grid">
          <div><small>Риск</small><span class="r${r.risk}">${RISK_L[r.risk]}</span></div>
          <div><small>Путь</small>${TRAVEL_L[r.travel]}</div>
          <div><small>Вложить</small>${fmt(b.cost)}</div>
          <div><small>Предметов</small>${b.count} (показано ${Math.min(5, b.count)})</div>
        </div>
        <div class="its">${lines}</div>
      </article>`;
    };
    $('list').innerHTML = (ranked ? `<p class="note">${arr.length ? HINTS[tab] : 'Для этой вкладки маршрутов не нашлось.'}</p>` : '')
      + arr.map(card).join('')
      + (ranked ? '<p class="note">Риск и длина пути — приблизительная оценка (вокруг Caerleon красные зоны), а не данные с карты. Вес и грузоподъёмность не учитываются, Чёрный рынок не включён.</p>' : '');
  }

  function render() {
    if (view === 'routes') return renderRoutes();
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
    running = true; stop = false; results = []; setView('single'); render();
    $('go').disabled = true; $('route').disabled = true; $('craft').disabled = true; $('stop').disabled = false; $('filters').open = false;
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
      running = false; $('go').disabled = false; $('route').disabled = false; $('craft').disabled = false; $('stop').disabled = true;
    }
  }

  async function scanRoutes() {
    if (running) return;
    const p = readParams();
    running = true; stop = false; ranked = null; tab = 'profit'; setView('routes'); render();
    $('go').disabled = true; $('route').disabled = true; $('craft').disabled = true; $('stop').disabled = false; $('filters').open = false;
    try {
      setStatus('Загружаю список предметов…');
      await loadItems();
      const ids = buildIdList(items, p);
      if (!ids.length) { setStatus('Под фильтры ничего не подошло.'); return; }
      p.from = p.city;   // отправная точка — город из фильтров
      const st = { items: ids.length };
      const loc = CITIES.map(encodeURIComponent).join(',');

      const rows = [], batches = [];
      for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
      for (let n = 0; n < batches.length && !stop; n++) {
        setStatus(`Цены из ${p.from} и во всех городах: запрос ${n + 1}/${batches.length} (предметов: ${ids.length})`);
        setProgress(n + 1, batches.length);
        try {
          rows.push(...await getJSON(`https://${p.server}/api/v2/stats/prices/${batches[n].join(',')}.json?locations=${loc}&qualities=1`));
        } catch (err) { st.failP = (st.failP || 0) + 1; }
        await sleep(PAUSE);
      }
      if (stop) { setStatus('Остановлено.'); return; }
      const opps = findOpps(rows, items, p, Date.now(), st);
      if (!opps.length) { setStatus(`Выгодных маршрутов из ${p.from} под фильтры нет.\n` + funnelRoutesText(st, p)); return; }

      const cand = candidateOpps(opps, p, 40);
      const cids = [...new Set(cand.map(o => o.id))];
      const vols = {}, hb = [];
      for (let i = 0; i < cids.length; i += BATCH_H) hb.push(cids.slice(i, i + BATCH_H));
      for (let n = 0; n < hb.length && !stop; n++) {
        setStatus(`Объёмы за 24ч: запрос ${n + 1}/${hb.length} (предметов ${cids.length})`);
        setProgress(n + 1, hb.length);
        try {
          sumVolumesByCity(await getJSON(`https://${p.server}/api/v2/stats/history/${hb[n].join(',')}?locations=${loc}&time-scale=1&qualities=1`), vols, Date.now());
        } catch (err) { st.failH = (st.failH || 0) + 1; }
        await sleep(PAUSE);
      }
      if (stop) { setStatus('Остановлено.'); return; }
      const routes = buildRoutes(cand, vols, p, st);
      ranked = rankRoutes(routes, 10);
      render();
      setStatus(`Готово: маршрутов из ${p.from} с прибылью: ${routes.length}.` + (namesRu ? '' : ' Русские названия не загрузились, показаны английские.') + '\n' + funnelRoutesText(st, p));
    } catch (err) {
      setStatus('Ошибка: ' + err.message);
    } finally {
      running = false; $('go').disabled = false; $('route').disabled = false; $('craft').disabled = false; $('stop').disabled = true;
    }
  }

  $('route').addEventListener('click', scanRoutes);
  $('tabs').addEventListener('click', e => {
    const t = e.target && e.target.dataset && e.target.dataset.tab;
    if (t) { tab = t; renderRoutes(); }
  });

  function readCraftParams() {
    const num = (id, d) => { const v = parseFloat(String($(id).value).replace(/\s/g, '')); return isNaN(v) ? d : v; };
    return {
      server: SERVERS[$('cserver').value], buyCity: $('cbuy').value, sellCity: $('csell').value, cat: $('ccat').value,
      tier: num('ctier', 4), ench: num('cench', 0), rrr: num('crrr', 0), fee: num('cfee', 0),
      buyMode: $('cbuymode').value, sellMode: $('csellmode').value,
      maxage: num('cmaxage', 180), minvol: num('cminvol', 0), minroi: num('cminroi', 0), maxroi: num('cmaxroi', 1e9),
      premium: $('cpremium').checked,
    };
  }

  async function loadRecipes() {
    if (recipes) return recipes;
    const cache = await caches.open('afh-data');
    const stamp = +localStorage.getItem('afh-recipes-ts') || 0;
    const old = await cache.match(RECIPES_KEY);
    if (old && Date.now() - stamp < RECIPES_TTL) { recipes = await old.json(); return recipes; }
    setStatus('Загружаю рецепты крафта (один раз в 30 дней, файл большой)…');
    let lastErr = null;
    for (const url of RECIPES_URLS) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const map = extractRecipes(await r.json());
        const n = Object.keys(map).length;
        if (n < MIN_RECIPES) throw new Error(`в файле нашлось только ${n} рецептов, формат не тот`);
        await cache.put(RECIPES_KEY, new Response(JSON.stringify(map), { headers: { 'Content-Type': 'application/json' } }));
        localStorage.setItem('afh-recipes-ts', String(Date.now()));
        recipes = map;
        return recipes;
      } catch (err) { lastErr = err; }
    }
    if (old) { recipes = await old.json(); return recipes; }   // нет сети — старый кэш
    throw new Error('Не удалось получить рецепты: ' + (lastErr && lastErr.message));
  }

  function renderCraft() {
    const key = $('csort').value;
    const arr = cresults.slice().sort((a, b) => b[key] - a[key]);
    $('clist').innerHTML = arr.map(r => `
      <article class="card">
        <header><b>${esc(r.name)}</b><span class="tier">${esc(r.tier)}</span></header>
        <div class="grid">
          <div><small>Себестоимость → цена</small>${fmt(r.cost)} → <b>${fmt(r.sell)}</b> (${r.mode === 'instant' ? 'сразу' : 'ордером'})</div>
          <div><small>Прибыль с шт. · ROI</small><b class="gain">+${fmt(r.profit)}</b> · ${r.roi}%</div>
          <div><small>Продано за 24ч</small>${fmt(r.vol)}</div>
          <div><small>За один крафт</small>${r.amount} шт.</div>
        </div>
        <div class="its">${r.comps.map(c => `<div class="comp">${c.count} × ${esc(c.name)} — ${fmt(c.price)}${c.returnable ? '' : ' (без возврата)'}</div>`).join('')}</div>
        <footer>данным ${r.age} мин</footer>
      </article>`).join('')
      + (arr.length ? '<p class="note">Себестоимость учитывает возврат ресурсов и плату станции из фильтров. Фокус, налог за использование станции по предмету и время крафта не считаются точно: проверь в игре.</p>' : '');
  }

  async function scanCraft() {
    if (running) return;
    const p = readCraftParams();
    running = true; stop = false; cresults = []; renderCraft();
    $('go').disabled = true; $('route').disabled = true; $('craft').disabled = true; $('stop').disabled = false; $('cfilters').open = false;
    try {
      setStatus('Загружаю список предметов…');
      await loadItems();
      await loadRecipes();
      const st = {};
      const ids = buildIdList(items, { cat: p.cat, tmin: p.tier, tmax: p.tier, emax: p.ench })
        .filter(id => tierEnchant(id)[1] === p.ench);
      st.items = ids.length;
      const withRec = ids.filter(id => recipes[id]);
      st.noRecipe = ids.length - withRec.length;
      if (!withRec.length) {
        setStatus(`Для T${p.tier}.${p.ench} в категории «${p.cat}» рецептов не нашлось (предметов: ${ids.length}, рецептов в базе: ${Object.keys(recipes).length}).`);
        return;
      }
      const need = new Set(withRec);
      for (const id of withRec) for (const [rid] of recipes[id].r) need.add(rid);
      const all = [...need];
      const loc = [...new Set([p.buyCity, p.sellCity])].map(encodeURIComponent).join(',');

      const rows = [], batches = [];
      for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH));
      for (let n = 0; n < batches.length && !stop; n++) {
        setStatus(`Цены: запрос ${n + 1}/${batches.length} (предметов ${withRec.length}, компонентов ${all.length - withRec.length})`);
        setProgress(n + 1, batches.length);
        try {
          rows.push(...await getJSON(`https://${p.server}/api/v2/stats/prices/${batches[n].join(',')}.json?locations=${loc}&qualities=1`));
        } catch (err) { st.failP = (st.failP || 0) + 1; }
        await sleep(PAUSE);
      }
      if (stop) { setStatus('Остановлено.'); return; }

      const cand = evalCrafts(withRec, recipes, rows, items, p, Date.now(), st);
      if (!cand.length) { setStatus('Прибыльных крафтов под фильтры нет.\n' + craftFunnelText(st, p)); return; }

      const vols = {}, cids = cand.map(c => c.id), hb = [];
      for (let i = 0; i < cids.length; i += BATCH_H) hb.push(cids.slice(i, i + BATCH_H));
      for (let n = 0; n < hb.length && !stop; n++) {
        setStatus(`Объёмы за 24ч: запрос ${n + 1}/${hb.length}`);
        setProgress(n + 1, hb.length);
        try {
          sumVolumesByCity(await getJSON(`https://${p.server}/api/v2/stats/history/${hb[n].join(',')}?locations=${encodeURIComponent(p.sellCity)}&time-scale=1&qualities=1`), vols, Date.now());
        } catch (err) { st.failH = (st.failH || 0) + 1; }
        await sleep(PAUSE);
      }
      if (stop) { setStatus('Остановлено.'); return; }
      cresults = [];
      for (const c of cand) {
        c.vol = vols[c.id + '|' + norm(p.sellCity)] || 0;
        if (c.vol < p.minvol) { st.lowVol = (st.lowVol || 0) + 1; continue; }
        cresults.push(c);
      }
      renderCraft();
      setStatus(`Готово: найдено ${cresults.length}.` + (namesRu ? '' : ' Русские названия не загрузились, показаны английские.') + '\n' + craftFunnelText(st, p));
    } catch (err) {
      setStatus('Ошибка: ' + err.message);
    } finally {
      running = false; $('go').disabled = false; $('route').disabled = false; $('craft').disabled = false; $('stop').disabled = true;
    }
  }

  $('pgFlip').addEventListener('click', () => { page = 'flip'; applyPage(); });
  $('pgCraft').addEventListener('click', () => { page = 'craft'; applyPage(); });
  $('craft').addEventListener('click', scanCraft);
  $('csort').addEventListener('change', () => renderCraft());

  $('go').addEventListener('click', scan);
  $('stop').addEventListener('click', () => { stop = true; });
  $('stop').disabled = true;
  applyPage();
  $('refresh').addEventListener('click', async () => {
    localStorage.removeItem('afh-items-ts'); localStorage.removeItem('afh-names-ts'); localStorage.removeItem('afh-recipes-ts'); items = null; recipes = null;
    try { const c = await caches.open('afh-data'); await c.delete(ITEMS_URL); await c.delete(NAMES_KEY); await c.delete(RECIPES_KEY); } catch (e) { /* ignore */ }
    setStatus('Список предметов обновится при следующем скане.');
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
