"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { registerPlatformRoutes } = require("../lib/platform-routes");
const { createDispatchService } = require("../lib/dispatch-service");
const dispatchCore = require("../lib/dispatch-core");
const hexgrid = require("../lib/hexgrid");
const pickupLoc = require("../lib/pickup-location");
const catalog = require("../lib/catalog");
const lifecycle = require("../lib/order-lifecycle");

function makeMockApp() {
  const routes = [];
  const reg = (method) => (path, ...h) => routes.push({ method, path, h: h.flat() });
  const app = { get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE"), patch: reg("PATCH") };
  async function call(method, url, { headers = {}, body = {}, query = {} } = {}) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const rp = r.path.split("/"), up = url.split("/");
      if (rp.length !== up.length) continue;
      const params = {};
      if (!rp.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = up[i]), true) : seg === up[i]))) continue;
      const hdr = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const req = { params, body, query, headers: hdr, header: (k) => hdr[k.toLowerCase()], ip: "127.0.0.1" };
      return await new Promise((resolve) => {
        const resHeaders = {};
        const res = {
          code: 200,
          headers: resHeaders,
          setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
          set(k, v) { resHeaders[k.toLowerCase()] = v; return this; },
          status(c) { this.code = c; return this; },
          json(o) { resolve({ status: this.code, body: o, headers: resHeaders }); },
          send(s) { resolve({ status: this.code, body: s, headers: resHeaders }); },
        };
        let i = 0;
        const next = () => { const fn = r.h[i++]; if (fn) fn(req, res, next); };
        next();
      });
    }
    throw new Error(`No route ${method} ${url}`);
  }
  return { app, call };
}

test("platform routes: driver review/suspension, verification codes, wallet, zones, reports, and health", async () => {
  const { app, call } = makeMockApp();
  const state = {
    otp: { challenges: [], proofs: [], revokedUsers: {}, revokedTokens: [] },
    wallet: {},
    promos: { coupons: [] },
    exceptions: { cases: [], complaints: [] },
    zones: { zones: [] },
    config: {},
    customers: [{ id: "cust_1", name: "Yassine", phone: "0611223344", isVerified: true }],
    drivers: [
      { id: "drv_1", name: "Karim", phone: "0699887766", status: "pending", isVerified: false, isActive: false },
    ],
    restaurants: [
      { id: "rest_1", name: { ar: "مطعم برشيد", fr: "Resto Berrechid", en: "Berrechid Resto" }, lat: 33.2655, lng: -7.5875, commissionPct: 15, isActive: true },
    ],
    orders: [
      {
        id: "ord_1",
        restaurantId: "rest_1",
        customerId: "cust_1",
        driverId: "drv_1",
        status: "accepted",
        subtotal: 100,
        deliveryFee: 12,
        total: 112,
        customer: { name: "Yassine", phone: "0611223344", addr: "Hay Hassani, Berrechid", location: { lat: 33.27, lng: -7.58 } },
        createdAt: new Date().toISOString(),
      },
    ],
    admins: [{ id: "adm_1", username: "admin", role: "system_admin", isActive: true }],
    auditLogs: [],
  };
  const codes = lifecycle.initOrderVerification(state.orders[0], { pickupCodeFixed: "4321", deliveryCodeFixed: "8765" });

  const fileMap = {
    "otp.json": "otp",
    "wallet.json": "wallet",
    "promos.json": "promos",
    "exceptions.json": "exceptions",
    "zones.json": "zones",
  };

  registerPlatformRoutes(app, {
    requireAdmin: (req, res, next) => {
      if (!req.header("x-admin")) return res.status(401).json({ error: "Unauthorized" });
      req.adminId = state.admins[0].id;
      req.admin = state.admins[0];
      next();
    },
    requireCustomer: (req, res, next) => {
      const cid = req.header("x-customer");
      if (!cid) return res.status(401).json({ error: "Unauthorized" });
      req.customerId = cid;
      next();
    },
    requireDriver: (req, res, next) => {
      const did = req.header("x-driver");
      if (!did) return res.status(401).json({ error: "Unauthorized" });
      req.driverId = did;
      next();
    },
    requireApprovedDriver: (req, res, next) => {
      const did = req.header("x-driver");
      if (!did) return res.status(401).json({ error: "Unauthorized" });
      req.driverId = did;
      req.driver = state.drivers.find((d) => d.id === did);
      next();
    },
    readJson: (p, fb) => state[fileMap[p]] || fb,
    writeJson: (p, d) => { state[fileMap[p]] = d; },
    loadConfig: () => state.config,
    saveConfig: (c) => { state.config = c; },
    loadOrders: () => ({ orders: state.orders }),
    saveOrders: (d) => { state.orders = d.orders; },
    loadCustomers: () => ({ customers: state.customers }),
    saveCustomers: (d) => { state.customers = d.customers; },
    loadDrivers: () => ({ drivers: state.drivers }),
    saveDrivers: (d) => { state.drivers = d.drivers; },
    loadRestaurants: () => ({ restaurants: state.restaurants }),
    saveRestaurants: (d) => { state.restaurants = d.restaurants; },
    loadMenu: () => ({ items: [] }),
    saveMenu: () => {},
    loadAdmins: () => ({ admins: state.admins }),
    saveAdmins: (d) => { state.admins = d.admins; },
    loadAuditLogs: () => ({ logs: state.auditLogs }),
    appendAuditLog: (e) => state.auditLogs.push(e),
    hashPassword: (pw) => "hashed:" + pw,
    verifyPassword: (pw, h) => h === "hashed:" + pw,
    makeId: (pfx) => pfx + "_test",
    catalogLib: catalog,
    routeService: {
      route: async () => ({ distance: 2500, duration: 360, provider: "osrm" }),
    },
    dispatchService: {
      reassignOrder: () => ({ ok: true }),
    },
    notifyCustomer: () => {},
    dataFiles: {
      otpFile: "otp.json",
      walletFile: "wallet.json",
      promosFile: "promos.json",
      exceptionsFile: "exceptions.json",
      zonesFile: "zones.json",
    },
  });

  // 1. Driver approval by supervisor records reviewer + timestamp
  const revDrv = await call("POST", "/api/admin/drivers/drv_1/review", {
    headers: { "x-admin": "1" },
    body: { status: "approved", reason: "Verified CIN and driving licence", vehicleType: "motorcycle", vehiclePlate: "12345-A-26" },
  });
  assert.equal(revDrv.status, 200);
  assert.equal(state.drivers[0].status, "approved");
  assert.equal(state.drivers[0].vehiclePlate, "12345-A-26");

  // 2. Customer gets deliveryCode only; driver verifies pickup then delivery
  const cVer = await call("GET", "/api/customer/orders/ord_1/verification", { headers: { "x-customer": "cust_1" } });
  assert.equal(cVer.status, 200);
  assert.equal(cVer.body.deliveryCode, codes.deliveryCode);
  assert.equal(cVer.body.pickupCode, undefined);

  const vPick = await call("POST", "/api/driver/orders/ord_1/verify-pickup", {
    headers: { "x-driver": "drv_1" },
    body: { code: "4321" },
  });
  assert.equal(vPick.status, 200);
  assert.equal(state.orders[0].status, "picked_up");

  const vDeliv = await call("POST", "/api/driver/orders/ord_1/verify-delivery", {
    headers: { "x-driver": "drv_1" },
    body: { code: "8765" },
  });
  assert.equal(vDeliv.status, 200);
  assert.equal(state.orders[0].status, "delivered");

  // 3. Road-distance pricing & Berrechid service zone endpoint
  const quote = await call("POST", "/api/delivery/estimate", {
    body: { restaurantId: "rest_1", lat: 33.271, lng: -7.582 },
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.roadDistanceKm, 2.5);
  assert.equal(quote.body.deliveryFee, 7.5); // 2.5 km * 3 MAD/km default Berrechid rate

  // 4. Reports export (CSV, Excel, PDF)
  const pdfRep = await call("GET", "/api/admin/reports/export", {
    headers: { "x-admin": "1" },
    query: { format: "pdf" },
  });
  assert.equal(pdfRep.status, 200);
  assert.equal(pdfRep.headers["content-type"], "application/pdf");
  assert.equal(Buffer.isBuffer(pdfRep.body), true);

  // 5. System Health Monitoring endpoint
  const health = await call("GET", "/api/admin/system-health", { headers: { "x-admin": "1" } });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.storage.status, "healthy");

  // 6. Role-scoped verification code isolation (customer, store, driver, admin)
  const freshOrder = { id: "ord_sec_test", status: "accepted" };
  const freshCodes = lifecycle.initOrderVerification(freshOrder);
  const forCust = lifecycle.sanitizeOrderVerificationForRole(freshOrder, "customer");
  const forStore = lifecycle.sanitizeOrderVerificationForRole(freshOrder, "store");
  const forDrv = lifecycle.sanitizeOrderVerificationForRole(freshOrder, "driver");
  assert.equal(forCust.deliveryCode, freshCodes.deliveryCode);
  assert.equal(forCust.pickupCode, undefined);
  assert.equal(forStore.pickupCode, freshCodes.pickupCode);
  assert.equal(forStore.deliveryCode, undefined);
  assert.equal(forDrv.pickupCode, undefined);
  assert.equal(forDrv.deliveryCode, undefined);

  // 7. Private driver document upload & supervisor audited document access
  const docUpload = await call("POST", "/api/driver/documents", {
    headers: { "x-driver": "drv_1" },
    body: {
      nationalIdNumber: "BH123456",
      licenseNumber: "LIC98765",
      vehicleType: "motorcycle",
      vehiclePlate: "12345-A-40",
      nationalIdDoc: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    },
  });
  assert.equal(docUpload.status, 200);
  assert.equal(docUpload.body.hasNationalIdDoc, true);

  const docView = await call("GET", "/api/admin/drivers/drv_1/documents", {
    headers: { "x-admin": "1" },
    query: { reason: "Verify driver ID" },
  });
  assert.equal(docView.status, 200);
  assert.equal(docView.body.driver.nationalIdNumber, "BH123456");
  assert.equal(
    state.auditLogs.some((l) => l.action === "driver_documents_accessed" && l.targetId === "drv_1"),
    true,
  );

  // 8. Business suspension safely handles active pre-pickup vs in-transit orders
  state.orders.push(
    { id: "ord_pre_pickup", restaurantId: "rest_1", customerId: "cust_1", status: "preparing" },
    { id: "ord_in_transit", restaurantId: "rest_1", customerId: "cust_1", driverId: "drv_1", status: "on_the_way" },
  );
  const bizSusp = await call("POST", "/api/admin/businesses/rest_1/status", {
    headers: { "x-admin": "1" },
    body: { status: "suspended", reason: "Health inspection pause" },
  });
  assert.equal(bizSusp.status, 200);
  assert.equal(bizSusp.body.business.onboardingStatus, "suspended");
  assert.deepEqual(bizSusp.body.activeOrderHandling.flaggedPrePickupOrders, ["ord_pre_pickup"]);
  assert.deepEqual(bizSusp.body.activeOrderHandling.continuingInTransitOrders, ["ord_in_transit"]);
});

test("H3 dispatch re-offers once to same driver on timeout when driver GPS is still fresh, and alerts supervisor on repeated rejections", () => {
  const alerts = [];
  let dispatchFileState = {};
  const orders = [
    { id: "o_disp", restaurantId: "r1", status: "restaurant_ready", deliveryFee: 15 },
  ];
  const restaurants = [
    { id: "r1", name: { en: "R1" }, lat: 33.2655, lng: -7.5875, isActive: true },
  ];
  const drivers = [
    { id: "d1", name: "D1", status: "approved", isActive: true },
    { id: "d2", name: "D2", status: "approved", isActive: true },
  ];
  let nowMs = 1_000_000;
  const ds = createDispatchService({
    core: dispatchCore,
    grid: hexgrid,
    file: "dispatch.json",
    readJson: () => dispatchFileState,
    writeJson: (_f, d) => { dispatchFileState = d; },
    loadOrders: () => ({ orders }),
    saveOrders: () => {},
    loadDrivers: () => ({ drivers }),
    loadRestaurants: () => ({ restaurants }),
    loadConfig: () => ({
      dispatchMode: "offers",
      dispatchAuto: true,
      dispatchOfferTtlMs: 25_000,
      dispatchReofferOnTimeout: true,
      dispatchRejectionAlertThreshold: 2,
    }),
    now: () => nowMs,
    onSupervisorAlert: (a) => alerts.push(a),
  });

  // Bring d1 and d2 online with fresh GPS fixes in Berrechid
  ds.updateLocation("d1", { lat: 33.2656, lng: -7.5874, accuracy: 10 });
  ds.setStatus("d1", "online");
  ds.updateLocation("d2", { lat: 33.266, lng: -7.587, accuracy: 10 });
  ds.setStatus("d2", "online");

  const started = ds.dispatchOrder("o_disp", { actor: "store" });
  assert.equal(started.ok, true);
  assert.equal(started.offer.driverId, "d1");

  // First timeout at +26s: d1 still has fresh GPS (updated at +20s), so dispatchOrder re-offers once to d1
  nowMs += 20_000;
  ds.updateLocation("d1", { lat: 33.2656, lng: -7.5874, accuracy: 10 });
  ds.updateLocation("d2", { lat: 33.266, lng: -7.587, accuracy: 10 });
  nowMs += 6_000;
  ds.tick();

  const d1Offers = ds.driverOffers("d1");
  assert.equal(d1Offers.length, 1);
  assert.equal(d1Offers[0].orderId, "o_disp");
  assert.equal(d1Offers[0].reofferedAfterTimeout, true);

  // d1 rejects -> moves to d2
  ds.rejectOffer("d1", d1Offers[0].id, "too_far");
  const d2Offers = ds.driverOffers("d2");
  assert.equal(d2Offers.length, 1);
  assert.equal(d2Offers[0].orderId, "o_disp");

  // d2 also rejects -> threshold=2 reached -> supervisor alert emitted
  ds.rejectOffer("d2", d2Offers[0].id, "busy");
  assert.equal(alerts.some((a) => a.type === "repeated_driver_rejections" && a.orderId === "o_disp"), true);
});

test("pickup-location respects showPickupOnDriverMap for driver map while catalog preserves customer listing visibility", () => {
  const hiddenStore = { id: "s_hidden", lat: 33.2655, lng: -7.5875, showPickupOnDriverMap: false };
  const visibleStore = { id: "s_vis", lat: 33.2655, lng: -7.5875, showPickupOnDriverMap: true };

  // Driver map hides pickup coordinates when showPickupOnDriverMap === false
  const drvHidden = pickupLoc.orderForDriver({ id: "o1", restaurantId: "s_hidden", driverId: "d1", status: "accepted" }, "d1", [hiddenStore]);
  assert.equal(drvHidden.pickup, null);
  assert.equal(drvHidden.pickupStore.hiddenOnDriverMap, true);

  // Dispatch and routing still resolve coordinates via resolvePickup
  const resolved = pickupLoc.resolvePickup({ id: "o1", restaurantId: "s_hidden" }, [hiddenStore]);
  assert.equal(resolved.lat, 33.2655);
  assert.equal(resolved.lng, -7.5875);

  // Driver map shows pickup coordinates when showPickupOnDriverMap === true
  const drvVis = pickupLoc.orderForDriver({ id: "o2", restaurantId: "s_vis", driverId: "d1", status: "accepted" }, "d1", [visibleStore]);
  assert.equal(drvVis.pickup.lat, 33.2655);

  // Catalog customer store status includes closed/busy/holiday status without hiding the business from customers
  const stHoliday = catalog.publicStore({ id: "s1", isActive: true, holidays: ["2026-10-23"] }, new Date("2026-10-23T12:00:00Z"));
  assert.equal(stHoliday.isOpen, false);
  assert.equal(stHoliday.availabilityStatus, "holiday");
});
