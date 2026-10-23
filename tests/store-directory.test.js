"use strict";
const test = require("node:test");
const assert = require("node:assert");
const catalogLib = require("../lib/catalog");
const { buildStoreDirectory, performanceOf } = require("../lib/store-directory");

const NOW = Date.parse("2026-10-23T12:00:00Z");
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const store = (id, extra = {}) => ({ id, name: { ar: id, en: `Store ${id}`, fr: id }, type: "restaurant", isActive: true, ...extra });
const order = (restaurantId, total, stars, daysAgo, status = "delivered") => ({
  restaurantId, total, status, createdAt: day(daysAgo), ...(stars ? { customerRating: { stars } } : {}),
});
const restaurants = [
  store("a", { channel: "online", phone: "+212600000001", website: "a.example.com" }),
  store("b", { channel: "offline", address: "12 Rue X", city: "Fes" }),
  store("c", { status: "unpublished" }), // closed, channel defaults to online
  store("d", { status: "archived" }),    // excluded
  store("e", { channel: "offline" }),
];
const orders = [
  order("a", 100, 5, 5), order("a", 50, 4, 10), order("a", 40, 5, 40), order("a", 999, 5, 3, "canceled"),
  order("b", 200, 3, 2), order("b", 20, null, 45),
  order("zzz", 5, 5, 1), // unknown store is ignored
];
const run = (query = {}) => buildStoreDirectory({ restaurants, orders, catalogLib, now: NOW, query });

test("excludes archived stores and counts KPIs from real data", () => {
  const { summary, total } = run();
  assert.equal(total, 4);
  assert.equal(summary.totalStores, 4);
  assert.equal(summary.onlineStores, 2);
  assert.equal(summary.offlineStores, 2);
  assert.equal(summary.openStores, 3);
  assert.equal(summary.closedStores, 1);
  assert.equal(summary.totalSales, 410); // delivered only
  assert.equal(summary.totalOrders, 5);
  assert.equal(summary.topStore.id, "b"); // 220 vs 190
});

test("ratings, performance and growth", () => {
  const { stores, summary } = run();
  const a = stores.find((s) => s.id === "a");
  assert.equal(a.rating, 4.7);
  assert.equal(a.reviews, 3); // only delivered orders count
  assert.equal(a.performance, "good");
  assert.equal(stores.find((s) => s.id === "b").performance, "attention");
  assert.equal(stores.find((s) => s.id === "e").performance, null); // no reviews -> nothing invented
  // last 30d: a 150 + b 200 = 350 ; previous 30d: a 40 + b 20 = 60
  assert.equal(summary.salesGrowthPct, 483.3);
  assert.equal(summary.avgRating, 4.3); // (5+4+5+3)/4 = 4.25, weighted by reviews
  assert.equal(performanceOf(4.0, 1), "average");
  assert.equal(performanceOf(null, 0), null);
});

test("empty data gives null stats, not made-up numbers", () => {
  const r = buildStoreDirectory({ restaurants: [], orders: [], catalogLib, now: NOW });
  assert.equal(r.total, 0);
  assert.equal(r.summary.avgRating, null);
  assert.equal(r.summary.salesGrowthPct, null);
  assert.equal(r.summary.topStore, null);
  assert.equal(r.totalPages, 1);
});

test("search and filters combine", () => {
  assert.deepEqual(run({ q: "rue x" }).stores.map((s) => s.id), ["b"]);
  assert.deepEqual(run({ q: "A.EXAMPLE" }).stores.map((s) => s.id), ["a"]);
  assert.deepEqual(run({ channel: "offline" }).stores.map((s) => s.id), ["b", "e"]);
  assert.deepEqual(run({ status: "closed" }).stores.map((s) => s.id), ["c"]);
  assert.deepEqual(run({ perf: "none" }).stores.map((s) => s.id).sort(), ["c", "e"]);
  assert.deepEqual(run({ channel: "offline", perf: "attention" }).stores.map((s) => s.id), ["b"]);
  assert.equal(run({ q: "nothing-matches" }).total, 0);
  assert.equal(run({ channel: "bogus" }).total, 4); // invalid filter values are ignored
});

test("pagination never loses or duplicates records", () => {
  const many = Array.from({ length: 23 }, (_, i) => store("s" + String(i).padStart(2, "0")));
  const q = (query) => buildStoreDirectory({ restaurants: many, orders: [], catalogLib, now: NOW, query });
  const seen = [];
  const first = q({ pageSize: 6, page: 1 });
  assert.equal(first.totalPages, 4);
  for (let p = 1; p <= first.totalPages; p++) seen.push(...q({ pageSize: 6, page: p }).stores.map((s) => s.id));
  assert.equal(seen.length, 23);
  assert.equal(new Set(seen).size, 23);
  assert.equal(q({ pageSize: 6, page: 99 }).page, 4); // clamped
  assert.equal(q({ pageSize: "all" }).stores.length, 23);
  assert.equal(q({ pageSize: 6, page: 2, q: "s1" }).total, 10); // search + pagination
});

test("channel/website are accepted by the store meta picker", () => {
  const out = catalogLib.pickStoreMeta({ channel: "offline", website: "https://shop.example.com/x" }, (v) => v, (v) => v);
  assert.equal(out.channel, "offline");
  assert.equal(out.website, "shop.example.com/x");
  assert.equal(catalogLib.pickStoreMeta({ channel: "weird" }, (v) => v).channel, "online");
});
