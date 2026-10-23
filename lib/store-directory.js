"use strict";
/**
 * Store directory for the admin "Stores" page.
 * Pure functions over the existing JSON records (restaurants + orders): no new storage, no invented numbers.
 *  - rating / reviews  -> order.customerRating.stars (the rating customers already leave on orders)
 *  - sales / orders    -> completed orders (delivered | done) per store
 *  - performance       -> derived from the average rating (null when a store has no reviews)
 *  - channel           -> store.channel ("online" | "offline"); stores without the field count as online
 *  - open / closed     -> catalogLib.isOpenNow (published + inside opening hours)
 * Archived stores are left out (they are restored from the Menu page).
 */

const DONE = new Set(["delivered", "done"]);
const DAY = 86400000;
const PERF = { good: 4.5, average: 4.0 }; // avg >= 4.5 good, >= 4.0 average, else needs attention

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function performanceOf(rating, reviews) {
  if (!reviews) return null;
  if (rating >= PERF.good) return "good";
  if (rating >= PERF.average) return "average";
  return "attention";
}

function channelOf(store) {
  return store && store.channel === "offline" ? "offline" : "online";
}

/** One pass over the orders: per-store sales, orders, rating sums, and 30-day windows for growth. */
function aggregateOrders(orders, now) {
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { sales: 0, orders: 0, stars: 0, reviews: 0, cur: 0, prev: 0 });
    return by.get(id);
  };
  for (const o of orders || []) {
    const id = String((o && o.restaurantId) || "");
    if (!id) continue;
    const a = get(id);
    const status = String(o.status || "new");
    const t = Date.parse(o.createdAt);
    if (DONE.has(status)) {
      const total = Number(o.total || 0) || 0;
      a.sales += total;
      a.orders += 1;
      if (Number.isFinite(t)) {
        if (t >= now - 30 * DAY && t <= now) a.cur += total;
        else if (t >= now - 60 * DAY && t < now - 30 * DAY) a.prev += total;
      }
    }
    // customers can only rate delivered orders; counting them here keeps reviews tied to completed sales
    const stars = Number(o.customerRating && o.customerRating.stars);
    if (DONE.has(status) && stars >= 1 && stars <= 5) {
      a.stars += stars;
      a.reviews += 1;
    }
  }
  return by;
}

function nameText(n, id) {
  if (n && typeof n === "object") return n.en || n.ar || n.fr || String(id);
  return String(n || id);
}

function toCard(store, agg, catalogLib, now) {
  const a = agg || { sales: 0, orders: 0, stars: 0, reviews: 0 };
  const rating = a.reviews ? round(a.stars / a.reviews, 1) : null;
  const status = catalogLib.effectiveStatus(store);
  return {
    id: String(store.id),
    name: store.name || { ar: "", en: "", fr: "" },
    label: nameText(store.name, store.id),
    logo: store.logo || "",
    phone: store.phone || "",
    address: store.address || "",
    city: store.city || "",
    area: store.area || "",
    website: store.website || "",
    type: store.type || "restaurant",
    channel: channelOf(store),
    status,
    isOpen: catalogLib.isOpenNow(store, new Date(now)),
    rating,
    reviews: a.reviews,
    performance: performanceOf(rating, a.reviews),
    sales: round(a.sales),
    orders: a.orders,
  };
}

function matches(c, f) {
  if (f.channel && c.channel !== f.channel) return false;
  if (f.type && c.type !== f.type) return false;
  if (f.status === "open" && !c.isOpen) return false;
  if (f.status === "closed" && c.isOpen) return false;
  if (f.perf) {
    const p = c.performance || "none";
    if (p !== f.perf) return false;
  }
  if (f.q) {
    const hay = [c.name.ar, c.name.en, c.name.fr, c.label, c.city, c.area, c.address, c.phone, c.website, c.type]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function summarize(cards, byId, now) {
  let cur = 0;
  let prev = 0;
  let reviews = 0;
  let stars = 0;
  for (const c of cards) {
    const a = byId.get(c.id);
    if (a) { cur += a.cur; prev += a.prev; reviews += a.reviews; stars += a.stars; } // raw sums: no rounding drift
  }
  const top = cards.filter((c) => c.sales > 0).sort((a, b) => b.sales - a.sales)[0] || null;
  return {
    totalStores: cards.length,
    onlineStores: cards.filter((c) => c.channel === "online").length,
    offlineStores: cards.filter((c) => c.channel === "offline").length,
    openStores: cards.filter((c) => c.isOpen).length,
    closedStores: cards.filter((c) => !c.isOpen).length,
    totalSales: round(cards.reduce((s, c) => s + c.sales, 0)),
    totalOrders: cards.reduce((s, c) => s + c.orders, 0),
    salesGrowthPct: prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null, // last 30 days vs the 30 before
    avgRating: reviews ? round(stars / reviews, 1) : null,
    reviews,
    topStore: top ? { id: top.id, label: top.label, sales: top.sales } : null,
  };
}

/**
 * @param {object} p {restaurants, orders, catalogLib, now?, query?}
 * query: q, channel(online|offline), status(open|closed), perf(good|average|attention|none), type,
 *        page (1-based), pageSize (1..100 or "all")
 */
function buildStoreDirectory({ restaurants, orders, catalogLib, now = Date.now(), query = {} }) {
  const list = (restaurants || []).filter((s) => s && catalogLib.effectiveStatus(s) !== "archived");
  const byId = aggregateOrders(orders, now);
  const cards = list.map((s) => toCard(s, byId.get(String(s.id)), catalogLib, now));
  const f = {
    q: String(query.q || "").trim().toLowerCase().slice(0, 100),
    channel: ["online", "offline"].includes(query.channel) ? query.channel : "",
    status: ["open", "closed"].includes(query.status) ? query.status : "",
    perf: ["good", "average", "attention", "none"].includes(query.perf) ? query.perf : "",
    type: String(query.type || "").slice(0, 60),
  };
  const filtered = cards.filter((c) => matches(c, f));
  filtered.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)); // stable: no duplicates across pages
  const all = String(query.pageSize) === "all";
  const pageSize = all ? Math.max(filtered.length, 1) : Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 6));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, parseInt(query.page, 10) || 1));
  return {
    stores: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize: all ? "all" : pageSize,
    total: filtered.length,
    totalPages,
    summary: summarize(cards, byId, now),
  };
}

module.exports = { buildStoreDirectory, performanceOf, PERF };
