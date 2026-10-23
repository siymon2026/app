"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../lib/order-lifecycle");
const zonesPricing = require("../lib/service-zones-pricing");

test("order state machine enforces valid transitions and blocks customer edits after business acceptance", () => {
  assert.equal(lifecycle.canTransitionStatus("new", "admin_accepted"), true);
  assert.equal(lifecycle.canTransitionStatus("new", "delivered"), false);

  // Customer can cancel or edit before business acceptance
  assert.equal(lifecycle.canCustomerCancel({ status: "new" }).ok, true);
  assert.equal(lifecycle.canCustomerEdit({ status: "admin_accepted", storeAcceptedAt: null }).ok, true);

  // Customer cannot cancel or edit after business acceptance
  assert.equal(lifecycle.canCustomerCancel({ status: "admin_accepted", storeAcceptedAt: "2026-10-23T10:00:00Z" }).ok, false);
  assert.equal(lifecycle.canCustomerCancel({ status: "restaurant_ready" }).ok, false);
  assert.equal(lifecycle.canCustomerEdit({ status: "accepted" }).ok, false);
});

test("independent pickup and delivery verification codes enforce one-time use, attempt limits, and role privacy", () => {
  const order = { id: "ord_100", status: "accepted", driverId: "drv_1" };
  const codes = lifecycle.initOrderVerification(order, { pickupCodeFixed: "1357", deliveryCodeFixed: "2468" });
  assert.equal(codes.pickupCode, "1357");
  assert.equal(codes.deliveryCode, "2468");

  // Store sees pickupCode only; customer sees deliveryCode only; driver sees neither code
  const storeView = lifecycle.sanitizeOrderVerificationForRole(order, "store");
  assert.equal(storeView.pickupCode, "1357");
  assert.equal(storeView.deliveryCode, undefined);

  const custView = lifecycle.sanitizeOrderVerificationForRole(order, "customer");
  assert.equal(custView.deliveryCode, "2468");
  assert.equal(custView.pickupCode, undefined);

  const drvView = lifecycle.sanitizeOrderVerificationForRole(order, "driver");
  assert.equal(drvView.pickupCode, undefined);
  assert.equal(drvView.deliveryCode, undefined);

  // Delivery cannot be verified before pickup is verified
  const prematureDelivery = lifecycle.verifyStageCode(order, { stage: "delivery", code: "2468", driverId: "drv_1" });
  assert.equal(prematureDelivery.ok, false);
  assert.equal(prematureDelivery.error, "pickup_not_verified_yet");

  // Wrong pickup code increments attempts
  const badPickup = lifecycle.verifyStageCode(order, { stage: "pickup", code: "9999", driverId: "drv_1" });
  assert.equal(badPickup.ok, false);
  assert.equal(badPickup.error, "invalid_verification_code");

  // Correct pickup code verifies pickup
  const okPickup = lifecycle.verifyStageCode(order, { stage: "pickup", code: "1357", driverId: "drv_1" });
  assert.equal(okPickup.ok, true);
  assert.ok(order.verification.pickup.verifiedAt);

  // One-time use: re-verifying pickup fails
  const replayPickup = lifecycle.verifyStageCode(order, { stage: "pickup", code: "1357", driverId: "drv_1" });
  assert.equal(replayPickup.ok, false);
  assert.equal(replayPickup.error, "verification_code_already_used");

  // Now delivery code can be verified
  const okDelivery = lifecycle.verifyStageCode(order, { stage: "delivery", code: "2468", driverId: "drv_1" });
  assert.equal(okDelivery.ok, true);
  assert.ok(order.verification.delivery.verifiedAt);
});

test("supervisor documented override satisfies verification with mandatory reason", () => {
  const order = { id: "ord_101", status: "accepted", driverId: "drv_1" };
  lifecycle.initOrderVerification(order, { pickupCodeFixed: "1111", deliveryCodeFixed: "2222" });

  const noReason = lifecycle.supervisorOverrideVerification(order, { stage: "pickup", supervisorId: "sup_1", reason: "abc" });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.error, "override_reason_required");

  const ok = lifecycle.supervisorOverrideVerification(order, {
    stage: "pickup",
    supervisorId: "sup_1",
    reason: "Store tablet battery died; confirmed pickup by phone with store manager",
  });
  assert.equal(ok.ok, true);
  assert.ok(order.verification.pickup.verifiedAt);
});

test("Berrechid service zone validates pickup & delivery coordinates and max road distance", () => {
  const berrechidStore = { lat: 33.2655, lng: -7.5875 };
  const berrechidCustomer = { lat: 33.271, lng: -7.582 };
  const casablancaFar = { lat: 33.5731, lng: -7.5898 };

  const inside = zonesPricing.checkServiceZoneEligibility({
    pickup: berrechidStore,
    dropoff: berrechidCustomer,
  });
  assert.equal(inside.ok, true);
  assert.equal(inside.zoneId, "zone-berrechid-main");

  const outside = zonesPricing.checkServiceZoneEligibility({
    pickup: berrechidStore,
    dropoff: casablancaFar,
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.error, "outside_service_zone");
});

test("road-distance delivery pricing uses per-km rate with 0 default base fee and fails safely when routing is unavailable", async () => {
  const pickup = { lat: 33.2655, lng: -7.5875 };
  const dropoff = { lat: 33.2755, lng: -7.5775 };

  // Mock road routing returning 3.5 km (3500m) and 480s
  const res = await zonesPricing.calculateRoadDeliveryPricing({
    pickup,
    dropoff,
    routeService: { route: async () => ({ distance: 3500, duration: 480, fallback: false }) },
    pricingOverride: {
      baseFee: 0,
      pricePerKm: 4,
      minDeliveryFee: 0,
      driverEarnings: {
        basePay: 5,
        distanceRatePerKm: 2.5,
      },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.roadDistanceKm, 3.5);
  assert.equal(res.pricingSnapshot.baseFee, 0);
  assert.equal(res.deliveryFee, 14); // 3.5 km * 4 MAD/km = 14 MAD
  assert.equal(res.driverEarningsSnapshot.totalEarnings, 13.75); // 5 + (3.5 * 2.5) = 13.75 MAD

  // When road routing fails or returns fallback, never fabricate distance
  const failRes = await zonesPricing.calculateRoadDeliveryPricing({
    pickup,
    dropoff,
    routeService: { route: async () => ({ distance: 2000, duration: 300, fallback: true }) },
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.error, "routing_service_unavailable");
});
