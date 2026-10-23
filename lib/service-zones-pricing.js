"use strict";
/**
 * Geographic Service Areas (Berrechid & Multi-City), Road-Distance Delivery Pricing,
 * and Driver Earnings Calculation (Sections 10, 18)
 *
 * Keeps H3 driver-search rings strictly separate from customer service-zone eligibility
 * and road-distance pricing.
 */
const { normalizeCoords } = require("./pickup-location");

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const DEFAULT_BERRECHID_ZONE = {
  id: "zone-berrechid-main",
  name: { ar: "برشيد المركز والمحيط", fr: "Berrechid Centre & Périphérie", en: "Berrechid Central & Surroundings" },
  city: "Berrechid",
  isActive: true,
  type: "radius", // "radius" | "polygon"
  center: { lat: 33.2655, lng: -7.5875 },
  radiusKm: 15,
  maxRoadDistanceKm: 20,
  polygon: null,
  pricing: {
    pricePerKm: 3.0,        // MAD per road km
    baseFee: 0,             // No base fee by default (Section 10)
    minDeliveryFee: 0,
    maxDeliveryFee: 150,
  },
  driverEarnings: {
    basePay: 5.0,           // Configurable driver base pay (MAD)
    distanceRatePerKm: 2.0, // Configurable driver distance rate (MAD/km)
  },
};

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  const x = point.lng;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Number(polygon[i][0]);
    const xi = Number(polygon[i][1]);
    const yj = Number(polygon[j][0]);
    const xj = Number(polygon[j][1]);
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInZone(point, zone) {
  const pt = normalizeCoords(point?.lat, point?.lng);
  if (!pt || !zone || zone.isActive === false) return false;
  if (zone.type === "polygon" && Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    return pointInPolygon(pt, zone.polygon);
  }
  const center = normalizeCoords(zone.center?.lat, zone.center?.lng);
  if (!center) return false;
  const radiusKm = Number(zone.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;
  const distKm = haversineM(center.lat, center.lng, pt.lat, pt.lng) / 1000;
  return distKm <= radiusKm;
}

function getActiveZones(zonesConfig) {
  const list = Array.isArray(zonesConfig) && zonesConfig.length > 0 ? zonesConfig : [DEFAULT_BERRECHID_ZONE];
  return list.filter((z) => z && z.isActive !== false);
}

/**
 * Check whether pickup and customer delivery coordinates fall inside an active service zone.
 */
function checkServiceZoneEligibility({ pickup, dropoff, delivery, zones }) {
  const activeZones = getActiveZones(zones);
  const targetDrop = dropoff || delivery;
  const dropPt = normalizeCoords(targetDrop?.lat, targetDrop?.lng);
  if (!dropPt) {
    return { ok: false, status: 400, error: "invalid_delivery_coordinates" };
  }
  const matchedZone = activeZones.find((z) => isPointInZone(dropPt, z));
  if (!matchedZone) {
    return {
      ok: false,
      status: 422,
      error: "outside_service_zone",
      message: "Delivery location is outside active service zones",
    };
  }
  const pickPt = normalizeCoords(pickup?.lat, pickup?.lng);
  if (pickPt && !isPointInZone(pickPt, matchedZone)) {
    // Allow if pickup is in another active zone in the same city, otherwise reject
    const pickupZone = activeZones.find((z) => isPointInZone(pickPt, z));
    if (!pickupZone) {
      return {
        ok: false,
        status: 422,
        error: "pickup_outside_service_zone",
        message: "Business pickup location is outside active service zones",
      };
    }
  }
  return { ok: true, zone: matchedZone, zoneId: matchedZone.id };
}

/**
 * Calculate road distance, customer delivery fee, and driver earnings using the road-routing service.
 *
 * Section 10 requirements:
 * - Calculate delivery fees from road distance between pickup and delivery locations.
 * - Support configurable price per kilometer.
 * - Do not include a base fee unless explicitly configured (`baseFee` defaults to 0).
 * - Use the road-routing service; if unavailable, follow a clear failure path rather than silently faking road distance.
 * - Calculate driver earnings using configurable base pay plus distance rate and store snapshot on the order.
 */
async function calculateRoadDeliveryPricing({
  pickup,
  dropoff,
  delivery,
  routeService,
  routeFn,
  zones,
  pricingOverride = null,
}) {
  const targetDrop = dropoff || delivery;
  const pickPt = normalizeCoords(pickup?.lat, pickup?.lng);
  const dropPt = normalizeCoords(targetDrop?.lat, targetDrop?.lng);
  if (!pickPt) {
    return { ok: false, status: 422, error: "pickup_coordinates_missing" };
  }
  if (!dropPt) {
    return { ok: false, status: 400, error: "delivery_coordinates_missing" };
  }

  const zoneCheck = checkServiceZoneEligibility({ pickup: pickPt, dropoff: dropPt, zones });
  if (!zoneCheck.ok) return zoneCheck;
  const zone = zoneCheck.zone;

  const rfn = (routeService && typeof routeService.route === "function") ? (a, b) => routeService.route(a, b) : routeFn;
  if (typeof rfn !== "function") {
    return {
      ok: false,
      status: 503,
      error: "routing_service_unavailable",
      message: "Road routing service is not configured",
    };
  }

  let routeResult;
  try {
    routeResult = await rfn(pickPt, dropPt);
  } catch (err) {
    return {
      ok: false,
      status: err && err.status ? err.status : 502,
      error: "routing_service_unavailable",
      reason: err && err.message ? err.message : "route_failed",
    };
  }

  if (
    !routeResult ||
    routeResult.fallback === true ||
    !Number.isFinite(Number(routeResult.distance)) ||
    Number(routeResult.distance) < 0
  ) {
    return {
      ok: false,
      status: 502,
      error: "routing_service_unavailable",
      reason: routeResult && routeResult.fallback ? "fallback_not_permitted" : "invalid_route_distance",
    };
  }

  const roadDistanceM = Math.round(Number(routeResult.distance));
  const roadDistanceKm = Math.round((roadDistanceM / 1000) * 100) / 100;
  const durationS = Number.isFinite(Number(routeResult.duration)) ? Math.round(Number(routeResult.duration)) : null;

  const maxRoadKm = Number(pricingOverride?.maxRoadDistanceKm ?? zone.maxRoadDistanceKm ?? 20);
  if (Number.isFinite(maxRoadKm) && maxRoadKm > 0 && roadDistanceKm > maxRoadKm) {
    return {
      ok: false,
      status: 422,
      error: "exceeds_max_road_distance",
      roadDistanceKm,
      maxRoadDistanceKm: maxRoadKm,
    };
  }

  const pricingCfg = {
    ...(zone.pricing || DEFAULT_BERRECHID_ZONE.pricing),
    ...(pricingOverride || {}),
  };
  const earningsCfg = {
    ...(zone.driverEarnings || DEFAULT_BERRECHID_ZONE.driverEarnings),
    ...(pricingOverride?.driverEarnings || {}),
  };

  const pricePerKm = Math.max(0, Number(pricingCfg.pricePerKm ?? 3.0));
  const baseFee = Math.max(0, Number(pricingCfg.baseFee ?? 0)); // 0 unless explicitly configured
  let deliveryFee = Math.round((baseFee + roadDistanceKm * pricePerKm) * 100) / 100;
  if (Number.isFinite(Number(pricingCfg.minDeliveryFee)) && deliveryFee < Number(pricingCfg.minDeliveryFee)) {
    deliveryFee = Number(pricingCfg.minDeliveryFee);
  }
  if (Number.isFinite(Number(pricingCfg.maxDeliveryFee)) && Number(pricingCfg.maxDeliveryFee) > 0 && deliveryFee > Number(pricingCfg.maxDeliveryFee)) {
    deliveryFee = Number(pricingCfg.maxDeliveryFee);
  }

  const driverBasePay = Math.max(0, Number(earningsCfg.basePay ?? 5.0));
  const driverRatePerKm = Math.max(0, Number(earningsCfg.distanceRatePerKm ?? 2.0));
  const driverDistancePay = Math.round(roadDistanceKm * driverRatePerKm * 100) / 100;
  const driverTotalEarnings = Math.round((driverBasePay + driverDistancePay) * 100) / 100;

  return {
    ok: true,
    zoneId: zone.id,
    zoneName: zone.name,
    city: zone.city || "Berrechid",
    roadDistanceM,
    roadDistanceKm,
    durationS,
    provider: routeResult.provider || "osrm",
    deliveryFee,
    pricingSnapshot: {
      zoneId: zone.id,
      roadDistanceM,
      roadDistanceKm,
      durationS,
      provider: routeResult.provider || "osrm",
      pricePerKm,
      baseFee,
      deliveryFee,
      calculatedAt: new Date().toISOString(),
    },
    driverEarningsSnapshot: {
      basePay: driverBasePay,
      distanceRatePerKm: driverRatePerKm,
      distancePay: driverDistancePay,
      totalEarnings: driverTotalEarnings,
      roadDistanceKm,
      calculatedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  DEFAULT_BERRECHID_ZONE,
  pointInPolygon,
  isPointInZone,
  getActiveZones,
  checkServiceZoneEligibility,
  calculateRoadDeliveryPricing,
};
