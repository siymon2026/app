"use strict";
const test = require("node:test");
const assert = require("node:assert");
const P = require("../lib/pickup-location");

const restaurants = [
  { id: "R1", name: { ar: "متجر ١", en: "Store One" }, address: "1 First St", city: "Casablanca", lat: 33.5731, lng: -7.5898 },
  { id: "R2", name: { ar: "متجر ٢", en: "Store Two" }, address: "2 Second Ave", city: "Berrechid", lat: 33.2655, lng: -7.5875 },
];
const order = (id, restaurantId, extra = {}) => ({
  id, restaurantId, status: "accepted", driverId: "D1",
  customer: { addr: "CUSTOMER ADDRESS MUST NOT BE PICKUP", lat: 34.1, lng: -6.2 }, ...extra,
});

test("coordinate validation rejects missing, partial, malformed and out-of-range points", () => {
  assert.deepEqual(P.normalizeCoords("33.5", "-7.5"), { lat: 33.5, lng: -7.5 });
  assert.equal(P.normalizeCoords(null, -7.5), null);
  assert.equal(P.normalizeCoords("", -7.5), null);
  assert.equal(P.normalizeCoords(33.5, undefined), null);
  assert.equal(P.normalizeCoords(true, -7.5), null);
  assert.equal(P.normalizeCoords(91, -7.5), null);
  assert.equal(P.normalizeCoords(33.5, -181), null);
  assert.equal(P.normalizeCoords(0, 0), null);
  assert.deepEqual(P.normalizeCoords(0, -7.5), { lat: 0, lng: -7.5 });
});

test("admin store coordinate writes validate, retain omitted values, and support clearing", () => {
  const current = { lat: 33.5, lng: -7.5 };
  assert.deepEqual(P.storeCoordinatesPatch({}, current), { ok: true, patch: {} });
  assert.deepEqual(P.storeCoordinatesPatch({ lat: "34.25" }, current), { ok: true, patch: { lat: 34.25, lng: -7.5 } });
  assert.deepEqual(P.storeCoordinatesPatch({ lat: 0, lng: -7.5 }), { ok: true, patch: { lat: 0, lng: -7.5 } });
  assert.deepEqual(P.storeCoordinatesPatch({ lat: "", lng: "" }, current), { ok: true, patch: { lat: null, lng: null } });
  assert.deepEqual(P.storeCoordinatesPatch({ lat: null, lng: null }, current), { ok: true, patch: { lat: null, lng: null } });
  for (const body of [{ lat: 33 }, { lat: "", lng: -7.5 }, { lat: null, lng: -7.5 }, { lat: 91, lng: -7.5 }, { lat: 0, lng: 0 }]) {
    assert.equal(P.storeCoordinatesPatch(body, {}).ok, false);
  }
});

test("two orders resolve their own stores, never the customer point", () => {
  const one = P.resolvePickup(order("O1", "R1"), restaurants, null);
  const two = P.resolvePickup(order("O2", "R2"), restaurants, null);
  assert.equal(one.storeId, "R1");
  assert.equal(two.storeId, "R2");
  assert.deepEqual([one.lat, one.lng], [33.5731, -7.5898]);
  assert.deepEqual([two.lat, two.lng], [33.2655, -7.5875]);
  assert.notDeepEqual([one.lat, one.lng], [two.lat, two.lng]);
  assert.equal(one.source, "store");
  assert.equal(one.address, "1 First St, Casablanca");
  assert.equal(one.name.en, "Store One");
  assert.notEqual(one.lat, 34.1);
  assert.notEqual(one.lng, -6.2);
});

test("configured fallback is preserved and labelled; no fallback means no invented point", () => {
  const stores = [{ id: "R-X", name: "Missing Coordinates", address: "Store address", lat: null, lng: -7.5 }];
  const o = order("OX", "R-X");
  assert.equal(P.resolvePickup(o, stores, null), null);
  const fallback = P.resolvePickup(o, stores, { lat: 33.2, lng: -7.4, name: "Default" });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.storeId, "R-X");
  assert.equal(fallback.name, "Missing Coordinates");
  assert.equal(fallback.address, "Store address");
  assert.deepEqual([fallback.lat, fallback.lng], [33.2, -7.4]);
});

test("driver pickup is restricted to that driver's active assignment and cleared on closure/reassignment", () => {
  const o = order("O1", "R1");
  const mine = P.orderForDriver(o, "D1", restaurants, null);
  assert.equal(mine.pickup.storeId, "R1");
  assert.equal(mine.pickupStore.address, "1 First St, Casablanca");
  for (const status of ["picked_up", "on_the_way"]) {
    assert.equal(P.orderForDriver({ ...o, status }, "D1", restaurants, null).pickup.storeId, "R1");
  }
  for (const status of ["delivered", "done", "canceled", "restaurant_ready"]) {
    const closed = P.orderForDriver({ ...o, status }, "D1", restaurants, null);
    assert.equal(closed.pickup, null);
    assert.equal(closed.pickupStore, null);
  }
  for (const changed of [{ driverId: "D2" }, { driverId: null }]) {
    const other = P.orderForDriver({ ...o, ...changed }, "D1", restaurants, null);
    assert.equal(other.pickup, null);
    assert.equal(other.pickupStore, null);
  }
  const replacement = P.orderForDriver(order("O2", "R2"), "D1", restaurants, null);
  assert.equal(replacement.pickup.storeId, "R2");
});

test("missing store coordinates retain store metadata but no marker point", () => {
  const stores = [{ id: "R1", name: "Known store", address: "Real store address", lat: null, lng: -7.5 }];
  const view = P.orderForDriver(order("O1", "R1"), "D1", stores, null);
  assert.equal(view.pickup, null);
  assert.equal(view.pickupStore.name, "Known store");
  assert.equal(view.pickupStore.address, "Real store address");
  assert.equal(view.pickupStore.lat, null);
});
