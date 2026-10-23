"use strict";
const test = require("node:test");
const assert = require("node:assert");
const core = require("../lib/dispatch-core");
const grid = require("../lib/hexgrid");
const { createDispatchService } = require("../lib/dispatch-service");

function setup(cfgOver = {}) {
  const files = {};
  let t = 1_000_000;
  const orders = { orders: [{ id: "O1", status: "restaurant_ready", restaurantId: "R1", subtotal: 50, deliveryFee: 10, total: 60, customerId: "C1" }] };
  const drivers = { drivers: ["A", "B", "C"].map((id) => ({ id, status: "approved", name: id, walletBalance: 1000 })) };
  const restaurants = { restaurants: [{ id: "R1", name: "Rest", address: "Store address", lat: 33.265, lng: -7.585 }] };
  const cfg = { dispatchMode: "offers", driverWalletEnabled: true, ...cfgOver };
  const accepted = [];
  const svc = createDispatchService({
    core, grid, file: "dispatch.json", now: () => t,
    readJson: (f, fb) => (files[f] ? JSON.parse(JSON.stringify(files[f])) : fb),
    writeJson: (f, d) => { files[f] = JSON.parse(JSON.stringify(d)); },
    loadOrders: () => orders, saveOrders: () => {}, loadDrivers: () => drivers,
    loadRestaurants: () => restaurants,
    loadConfig: () => cfg, onAccepted: (o) => accepted.push(o.id),
  });
  const online = (id, dLat) => {
    assert.ok(svc.updateLocation(id, { lat: 33.265 + dLat, lng: -7.585, accuracy: 20 }).ok);
    assert.ok(svc.setStatus(id, "online").ok);
  };
  return { svc, orders, drivers, restaurants, cfg, accepted, tick: (ms) => { t += ms; }, online };
}

test("status online requires a fresh valid location", () => {
  const { svc, tick } = setup();
  assert.equal(svc.setStatus("A", "online").error, "location_required");
  svc.updateLocation("A", { lat: 33.265, lng: -7.585, accuracy: 20 });
  tick(60_000); // stale
  assert.equal(svc.setStatus("A", "online").error, "location_required");
});

test("auto dispatch offers nearest driver; others see nothing", () => {
  const { svc, online } = setup();
  online("A", 0.01); online("B", 0.001); online("C", 0.02);
  const r = svc.dispatchOrder("O1");
  assert.ok(r.ok); assert.equal(r.offer.driverId, "B");
  assert.equal(svc.driverOffers("B").length, 1);
  assert.equal(svc.driverOffers("A").length, 0);
  assert.equal(svc.driverOffers("B")[0].customer, undefined);
});

test("accept assigns once; second driver cannot", () => {
  const { svc, orders, accepted, online } = setup();
  online("A", 0.001); online("B", 0.002);
  const o = svc.dispatchOrder("O1").offer;
  assert.equal(svc.acceptOffer("B", o.id).error, "not_your_offer");
  assert.ok(svc.acceptOffer("A", o.id).ok);
  assert.ok(svc.acceptOffer("A", o.id).ok); // idempotent retry
  assert.equal(orders.orders[0].driverId, "A");
  assert.deepEqual(accepted, ["O1"]);
});

test("reject re-offers to next driver; tick handles expiry", () => {
  const { svc, online, tick } = setup();
  online("A", 0.001); online("B", 0.002);
  const o1 = svc.dispatchOrder("O1").offer;
  assert.ok(svc.rejectOffer("A", o1.id).ok);
  assert.equal(svc.driverOffers("B").length, 1);
  tick(26_000); // B's offer expires; locations also go stale -> no candidates
  svc.updateLocation("A", { lat: 33.266, lng: -7.585, accuracy: 20 });
  svc.tick();
  const s = svc._loadState();
  assert.ok(s.offers.find((x) => x.driverId === "B").status === "expired");
});

test("wallet gate blocks accept", () => {
  const { svc, drivers, online } = setup();
  drivers.drivers[0].walletBalance = 1;
  online("A", 0.001);
  const o = svc.dispatchOrder("O1").offer;
  assert.equal(svc.acceptOffer("A", o.id).status, 402);
});

test("pull mode: no dispatch, default safe", () => {
  const { svc } = setup({ dispatchMode: undefined });
  assert.equal(svc.dispatchOrder("O1").error, "mode_pull");
});

test("implausible GPS jump is rejected", () => {
  const { svc, tick } = setup();
  svc.updateLocation("A", { lat: 33.265, lng: -7.585 });
  tick(2000);
  assert.equal(svc.updateLocation("A", { lat: 34.5, lng: -6.0 }).error, "implausible_jump");
});

test("admin state hides lost drivers' coordinates", () => {
  const { svc, online, tick } = setup();
  online("A", 0.001); tick(200_000);
  assert.equal(svc.adminState().drivers.find((d) => d.id === "A").location, null);
});

test("pull mode: going online does not require GPS", () => {
  const { svc } = setup({ dispatchMode: "pull" });
  assert.ok(svc.setStatus("A", "online").ok);
});

test("admin settings patch validates input", () => {
  const { svc } = setup();
  assert.equal(svc.settingsPatch({ mode: "x" }).error, "invalid_mode");
  assert.equal(svc.settingsPatch({ ttlSec: 5 }).error, "invalid_ttl");
  assert.equal(svc.settingsPatch({ pickup: { lat: 0, lng: 0 } }).error, "invalid_pickup");
  const r = svc.settingsPatch({ mode: "offers", auto: true, ttlSec: 30, pickup: { lat: 33.26, lng: -7.58, name: "R" } });
  assert.deepEqual(r.patch, { dispatchMode: "offers", dispatchAuto: true, dispatchOfferTtlMs: 30000, pickupLocation: { lat: 33.26, lng: -7.58, name: "R" } });
});

test("admin state reports pickup readiness and no driver phone/PII", () => {
  const { svc } = setup();
  const s = svc.adminState();
  assert.equal(s.pickupOk, true); // restaurant R1 has coordinates
  assert.ok(!JSON.stringify(s).includes("walletBalance"));
});

test("each order dispatches from its own store and accepted response carries that pickup", () => {
  const { svc, orders, restaurants, online } = setup({ dispatchRings: 5 });
  restaurants.restaurants.push({ id: "R2", name: "Second", address: "Second address", lat: 34.02, lng: -6.84 });
  orders.orders.push({ id: "O2", status: "restaurant_ready", restaurantId: "R2", subtotal: 20, deliveryFee: 5, total: 25 });
  online("A", 0.001); online("C", 0.002);
  assert.ok(svc.updateLocation("B", { lat: 34.02, lng: -6.84, accuracy: 20 }).ok);
  assert.ok(svc.setStatus("B", "online").ok);
  assert.equal(svc.dispatchOrder("O1").offer.driverId, "A");
  const second = svc.dispatchOrder("O2");
  assert.equal(second.offer.driverId, "B"); // not the other available driver near R1
  const offer = svc.driverOffers("B")[0];
  assert.equal(offer.pickup.storeId, "R2");
  assert.equal(offer.pickup.lat, 34.02);
  assert.equal(offer.pickup.source, "store");
  const pending = svc.adminState().pending;
  assert.equal(pending.find((o) => o.id === "O1").store.lat, 33.265);
  assert.equal(pending.find((o) => o.id === "O2").store.lat, 34.02);
  const accepted = svc.acceptOffer("B", second.offer.id);
  assert.ok(accepted.ok);
  assert.equal(accepted.order.pickup.storeId, "R2");
  assert.equal(accepted.order.pickup.address, "Second address");
});

test("missing store coordinates report no_pickup; configured fallback remains explicit", () => {
  const missing = setup();
  missing.restaurants.restaurants[0].lat = null;
  missing.online("A", 0.001);
  assert.equal(missing.svc.dispatchOrder("O1").error, "no_pickup_location");
  assert.equal(missing.svc.adminState().pending[0].store.lat, null);

  const fallback = setup({ pickupLocation: { lat: 33.265, lng: -7.585, name: "Default" } });
  fallback.restaurants.restaurants[0].lat = "";
  fallback.online("A", 0.001);
  const offer = fallback.svc.dispatchOrder("O1").offer;
  const pickup = fallback.svc.driverOffers(offer.driverId)[0].pickup;
  assert.equal(pickup.source, "fallback");
  assert.equal(pickup.storeId, "R1");
});

test("candidate search stops at the first successive ring with eligible drivers", () => {
  const now = 100000;
  const driver = (id, lat) => ({ id, status: "approved", dispatchState: "available",
    location: { lat, lng: 10, accuracy: 20, at: now } });
  const args = {
    pickup: { lat: 10, lng: 10 }, now, maxRings: 2,
    cellOf: (lat) => String(lat),
    ringOf: (_cell, k) => Array.from({ length: k + 1 }, (_, i) => String(10 + i)),
  };
  const ringOne = core.rankCandidates({ ...args, drivers: [driver("A", 11), driver("B", 12)] });
  assert.deepEqual(ringOne.map((d) => d.driverId), ["A"]);
  const storeCell = core.rankCandidates({ ...args, drivers: [driver("A", 11), driver("C", 10)] });
  assert.deepEqual(storeCell.map((d) => d.driverId), ["C"]);
  assert.deepEqual(core.rankCandidates({ ...args, drivers: [driver("B", 13)] }), []);
});

test("settings reject partial/blank fallback coordinates", () => {
  const { svc } = setup();
  assert.equal(svc.settingsPatch({ pickup: { lat: "", lng: -7.58 } }).error, "invalid_pickup");
  assert.equal(svc.settingsPatch({ pickup: { lat: null, lng: -7.58 } }).error, "invalid_pickup");
});
