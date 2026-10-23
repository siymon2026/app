"use strict";

/**
 * Store/order pickup locations derived from the existing restaurant records.
 * Nothing is persisted here and customer coordinates are never consulted.
 */

const ACTIVE_PICKUP_STATUSES = ["accepted", "picked_up", "on_the_way"];

/** Return normalized coordinates, or null for missing/invalid input. */
function normalizeCoords(lat, lng) {
  const validType = (v) => typeof v === "number" || typeof v === "string";
  if (!validType(lat) || !validType(lng)) return null;
  if ((typeof lat === "string" && !lat.trim()) || (typeof lng === "string" && !lng.trim())) return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: a, lng: b };
}

/** Validate admin coordinate writes; omitted fields retain the current pair. */
function storeCoordinatesPatch(body, current = {}) {
  const b = body || {};
  const hasLat = Object.prototype.hasOwnProperty.call(b, "lat");
  const hasLng = Object.prototype.hasOwnProperty.call(b, "lng");
  if (!hasLat && !hasLng) return { ok: true, patch: {} };
  const lat = hasLat ? b.lat : current.lat;
  const lng = hasLng ? b.lng : current.lng;
  const blank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());
  if (blank(lat) && blank(lng)) return { ok: true, patch: { lat: null, lng: null } };
  const point = normalizeCoords(lat, lng);
  return point ? { ok: true, patch: point } : { ok: false };
}

function storeAddress(store) {
  if (!store) return "";
  return [store.address, store.area, store.city]
    .map((v) => String(v == null ? "" : v).trim())
    .filter(Boolean)
    .join(", ");
}

function findOrderStore(order, restaurants) {
  if (!order) return null;
  const id = String(order.restaurantId || "");
  if (!id) return null;
  return (restaurants || []).find((r) => String(r && r.id) === id) || null;
}

/** Admin-safe store metadata; lat/lng stay null when no valid point exists. */
function storeLocation(store) {
  if (!store) return null;
  const point = normalizeCoords(store.lat, store.lng);
  return {
    id: String(store.id),
    name: store.name || "",
    address: storeAddress(store),
    lat: point ? point.lat : null,
    lng: point ? point.lng : null,
  };
}

function pickupFromStore(store) {
  const meta = storeLocation(store);
  if (!meta || meta.lat === null || meta.lng === null) return null;
  return {
    storeId: meta.id,
    lat: meta.lat,
    lng: meta.lng,
    name: meta.name,
    address: meta.address,
    source: "store",
  };
}

/**
 * Prefer the order's own store. The existing configured default is used only
 * when that store has no valid coordinates, and is explicitly labelled as a
 * fallback so callers never mistake it for a measured store location.
 */
function resolvePickup(order, restaurants, fallback) {
  const store = findOrderStore(order, restaurants);
  const actual = pickupFromStore(store);
  if (actual) return actual;
  const point = normalizeCoords(fallback && fallback.lat, fallback && fallback.lng);
  if (!point) return null;
  return {
    storeId: String((store && store.id) || (order && order.restaurantId) || ""),
    lat: point.lat,
    lng: point.lng,
    name: (store && store.name) || (fallback && fallback.name) || "",
    address: storeAddress(store),
    source: "fallback",
  };
}

/**
 * Driver response view. Pickup details exist only on the caller's active
 * assignment; closed, cancelled, unassigned and other drivers' orders get none.
 */
function orderForDriver(order, driverId, restaurants, fallback) {
  const out = { ...order, pickup: null, pickupStore: null };
  const mine = String((order && order.driverId) || "") === String(driverId || "");
  if (!mine || !ACTIVE_PICKUP_STATUSES.includes(String((order && order.status) || ""))) return out;
  const store = findOrderStore(order, restaurants);
  out.pickupStore = storeLocation(store);
  out.pickup = resolvePickup(order, restaurants, fallback);
  return out;
}

module.exports = {
  ACTIVE_PICKUP_STATUSES,
  normalizeCoords,
  storeCoordinatesPatch,
  storeAddress,
  findOrderStore,
  storeLocation,
  pickupFromStore,
  resolvePickup,
  orderForDriver,
};
