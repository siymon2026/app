"use strict";
/**
 * Single Authoritative Order State Machine, Pickup & Delivery Verification Codes,
 * Cancellation/Edit Policies, and Auditable Order Event History (Sections 5, 9, 14)
 */
const crypto = require("crypto");

const ORDER_STATUSES = [
  "new",
  "admin_accepted",
  "restaurant_ready",
  "accepted",
  "picked_up",
  "on_the_way",
  "delivered",
  "done",
  "rejected",
  "canceled",
  "driver_unavailable",
  "delayed",
  "failed_delivery",
  "refund_pending",
  "refund_completed",
  "sent",
];

const ALLOWED_TRANSITIONS = {
  new: ["admin_accepted", "rejected", "canceled"],
  admin_accepted: ["admin_accepted", "restaurant_ready", "delayed", "rejected", "canceled"],
  restaurant_ready: ["accepted", "driver_unavailable", "delayed", "canceled"],
  accepted: ["picked_up", "on_the_way", "restaurant_ready", "driver_unavailable", "delayed", "failed_delivery", "canceled"],
  picked_up: ["on_the_way", "delivered", "done", "delayed", "failed_delivery", "canceled"],
  on_the_way: ["delivered", "done", "delayed", "failed_delivery", "canceled"],
  delayed: ["restaurant_ready", "accepted", "picked_up", "on_the_way", "delivered", "done", "failed_delivery", "canceled"],
  driver_unavailable: ["restaurant_ready", "accepted", "canceled"],
  failed_delivery: ["on_the_way", "delivered", "canceled", "refund_pending"],
  rejected: ["canceled", "refund_pending", "refund_completed"],
  canceled: ["refund_pending", "refund_completed"],
  delivered: ["done", "refund_pending", "refund_completed"],
  done: ["refund_pending", "refund_completed"],
  refund_pending: ["refund_completed", "canceled", "delivered"],
  refund_completed: [],
  sent: ["restaurant_ready", "accepted", "picked_up", "on_the_way", "delivered", "canceled"],
};

function canTransitionStatus(fromStatus, toStatus) {
  const from = String(fromStatus || "new").toLowerCase();
  const to = String(toStatus || "").toLowerCase();
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

function appendOrderEvent(order, { type, fromStatus, toStatus, actorType, actorId, reason, meta, now = new Date().toISOString() }) {
  if (!order || typeof order !== "object") return;
  if (!Array.isArray(order.events)) order.events = [];
  order.events.push({
    id: "EVT-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    at: now,
    type: String(type || "status_change"),
    fromStatus: fromStatus != null ? String(fromStatus) : undefined,
    toStatus: toStatus != null ? String(toStatus) : undefined,
    actorType: String(actorType || "system"),
    actorId: actorId != null ? String(actorId) : null,
    reason: reason ? String(reason).slice(0, 300) : null,
    meta: meta && typeof meta === "object" ? meta : undefined,
  });
  if (order.events.length > 200) {
    order.events = order.events.slice(-200);
  }
}

/* ------------------------------------------------------------------ *
 * Customer Cancellation & Editing Rules (Section 5)
 * ------------------------------------------------------------------ */

/**
 * Customers can cancel or edit ONLY before the restaurant/store accepts the order.
 * Once the store accepts (`storeAcceptedAt` is set) or the order is `restaurant_ready`
 * or beyond, direct customer cancellation/editing is prohibited.
 */
function isBeforeStoreAcceptance(order) {
  if (!order) return false;
  const st = String(order.status || "new").toLowerCase();
  if (st === "new") return true;
  if (st === "admin_accepted" && !order.storeAcceptedAt && !order.driverId) return true;
  return false;
}

function canCustomerCancel(order) {
  if (!order) return { ok: false, status: 404, error: "not_found" };
  const st = String(order.status || "new").toLowerCase();
  if (["delivered", "done", "canceled", "rejected", "refund_pending", "refund_completed"].includes(st)) {
    return { ok: false, status: 409, error: "Order cannot be canceled" };
  }
  if (!isBeforeStoreAcceptance(order)) {
    return {
      ok: false,
      status: 409,
      error: "Order cannot be canceled after business acceptance",
      code: "already_accepted_by_store",
    };
  }
  return { ok: true };
}

function canCustomerEdit(order) {
  if (!order) return { ok: false, status: 404, error: "not_found" };
  if (!isBeforeStoreAcceptance(order)) {
    return {
      ok: false,
      status: 409,
      error: "Order can only be edited before business acceptance",
      code: "already_accepted_by_store",
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Pickup and Delivery Verification Codes (Section 9)
 * ------------------------------------------------------------------ */

const VERIFY_DEFAULTS = {
  ttlMs: 24 * 3600 * 1000, // 24 hours
  maxAttempts: 5,
};

function hashVerificationCode(orderId, stage, code) {
  return crypto
    .createHash("sha256")
    .update(`siymon-vcode:${String(orderId)}:${String(stage)}:${String(code).trim()}`, "utf8")
    .digest("hex");
}

function generateFourDigitCode() {
  return String(crypto.randomInt(1000, 10000));
}

/**
 * Generates independent pickup and delivery verification codes for an order.
 * Codes remain distinct so the pickup code can never be used as the delivery code.
 */
function initOrderVerification(order, { now = Date.now(), ttlMs = VERIFY_DEFAULTS.ttlMs, pickupCodeFixed, deliveryCodeFixed } = {}) {
  const pickupCode = pickupCodeFixed ? String(pickupCodeFixed) : generateFourDigitCode();
  let deliveryCode = deliveryCodeFixed ? String(deliveryCodeFixed) : generateFourDigitCode();
  while (deliveryCode === pickupCode && !deliveryCodeFixed) {
    deliveryCode = generateFourDigitCode();
  }
  const expiresAt = new Date(now + ttlMs).toISOString();
  order.verification = {
    pickup: {
      codeForStore: pickupCode, // stripped from driver/customer views, shown only to store & supervisor
      codeHash: hashVerificationCode(order.id, "pickup", pickupCode),
      attempts: 0,
      maxAttempts: VERIFY_DEFAULTS.maxAttempts,
      expiresAt,
      verifiedAt: null,
      verifiedBy: null,
      overrideReason: null,
    },
    delivery: {
      codeForCustomer: deliveryCode, // stripped from driver/store views, shown only to customer & supervisor
      codeHash: hashVerificationCode(order.id, "delivery", deliveryCode),
      attempts: 0,
      maxAttempts: VERIFY_DEFAULTS.maxAttempts,
      expiresAt,
      verifiedAt: null,
      verifiedBy: null,
      overrideReason: null,
    },
  };
  return { pickupCode, deliveryCode };
}

/**
 * Verify pickup or delivery code submitted by the assigned driver.
 */
function verifyStageCode(order, { stage, code, driverId, now = Date.now() }) {
  if (!order) return { ok: false, status: 404, error: "order_not_found" };
  if (stage !== "pickup" && stage !== "delivery") {
    return { ok: false, status: 400, error: "invalid_verification_stage" };
  }
  if (String(order.driverId || "") !== String(driverId || "")) {
    return { ok: false, status: 403, error: "not_assigned_driver" };
  }
  const st = String(order.status || "").toLowerCase();
  if (stage === "pickup" && !["accepted", "restaurant_ready"].includes(st)) {
    return { ok: false, status: 409, error: "invalid_order_state_for_pickup" };
  }
  if (stage === "delivery" && !["picked_up", "on_the_way", "delayed", "accepted"].includes(st)) {
    return { ok: false, status: 409, error: "invalid_order_state_for_delivery" };
  }
  if (stage === "delivery" && order.verification?.pickup && !order.verification.pickup.verifiedAt && st !== "picked_up" && st !== "on_the_way") {
    return { ok: false, status: 409, error: "pickup_not_verified_yet" };
  }

  if (!order.verification || !order.verification[stage]) {
    initOrderVerification(order, { now });
  }
  const v = order.verification[stage];
  if (v.verifiedAt) {
    return { ok: false, status: 409, error: "verification_code_already_used" };
  }
  const expMs = Date.parse(v.expiresAt || "");
  if (Number.isFinite(expMs) && now > expMs) {
    return { ok: false, status: 410, error: "verification_code_expired" };
  }
  if (v.attempts >= (v.maxAttempts || VERIFY_DEFAULTS.maxAttempts)) {
    return { ok: false, status: 429, error: "verification_max_attempts_exceeded" };
  }

  const cleanCode = String(code || "").trim();
  if (!cleanCode) {
    return { ok: false, status: 400, error: "verification_code_required" };
  }

  v.attempts += 1;
  const expectedHash = hashVerificationCode(order.id, stage, cleanCode);
  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(String(v.codeHash || ""), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_verification_code",
      remainingAttempts: Math.max(0, (v.maxAttempts || 5) - v.attempts),
    };
  }

  const nowIso = new Date(now).toISOString();
  v.verifiedAt = nowIso;
  v.verifiedBy = `driver:${driverId}`;

  appendOrderEvent(order, {
    type: `${stage}_verified`,
    fromStatus: order.status,
    toStatus: stage === "pickup" ? "picked_up" : "delivered",
    actorType: "driver",
    actorId: String(driverId),
    now: nowIso,
  });

  return { ok: true, stage, verifiedAt: nowIso };
}

/**
 * Authorized supervisor exception override when a code cannot be provided or connectivity fails.
 */
function supervisorOverrideVerification(order, { stage, supervisorId, reason, now = Date.now() }) {
  if (!order) return { ok: false, status: 404, error: "order_not_found" };
  if (stage !== "pickup" && stage !== "delivery") {
    return { ok: false, status: 400, error: "invalid_verification_stage" };
  }
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 5) {
    return { ok: false, status: 400, error: "override_reason_required" };
  }
  if (!order.verification || !order.verification[stage]) {
    initOrderVerification(order, { now });
  }
  const v = order.verification[stage];
  const nowIso = new Date(now).toISOString();
  v.verifiedAt = nowIso;
  v.verifiedBy = `supervisor:${supervisorId}`;
  v.overrideReason = cleanReason;

  appendOrderEvent(order, {
    type: `${stage}_supervisor_override`,
    fromStatus: order.status,
    toStatus: stage === "pickup" ? "picked_up" : "delivered",
    actorType: "supervisor",
    actorId: String(supervisorId),
    reason: cleanReason,
    now: nowIso,
  });

  return { ok: true, stage, verifiedAt: nowIso, overriddenBy: supervisorId };
}

/**
 * Sanitize order verification fields for a specific viewer role so secret codes never leak.
 * - "customer": sees `deliveryCode`, never `pickupCode`
 * - "store": sees `pickupCode`, never `deliveryCode`
 * - "driver": sees boolean `pickupVerified` and `deliveryVerified`, NEVER the raw codes!
 * - "supervisor": sees verification status & codes if authorized
 */
function sanitizeOrderVerificationForRole(order, role) {
  if (!order || typeof order !== "object") return order;
  const out = { ...order };
  if (!out.verification) return out;
  const p = out.verification.pickup || {};
  const d = out.verification.delivery || {};

  if (role === "customer") {
    out.deliveryCode = d.codeForCustomer || null;
    out.verificationStatus = {
      pickupVerified: !!p.verifiedAt,
      deliveryVerified: !!d.verifiedAt,
    };
    delete out.verification;
  } else if (role === "store" || role === "restaurant") {
    out.pickupCode = p.codeForStore || null;
    out.verificationStatus = {
      pickupVerified: !!p.verifiedAt,
      deliveryVerified: !!d.verifiedAt,
    };
    delete out.verification;
  } else if (role === "driver") {
    out.verificationStatus = {
      pickupVerified: !!p.verifiedAt,
      pickupAttempts: p.attempts || 0,
      deliveryVerified: !!d.verifiedAt,
      deliveryAttempts: d.attempts || 0,
    };
    delete out.verification;
  }
  return out;
}

module.exports = {
  ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransitionStatus,
  appendOrderEvent,
  isBeforeStoreAcceptance,
  canCustomerCancel,
  canCustomerEdit,
  initOrderVerification,
  verifyStageCode,
  supervisorOverrideVerification,
  sanitizeOrderVerificationForRole,
};
