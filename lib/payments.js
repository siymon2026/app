"use strict";
/**
 * Payment methods policy.
 *
 * Only Cash on Delivery is currently enabled. The online methods are known to
 * the system (so the UI can list them as "not activated yet") but the server
 * refuses to create an order with them. To enable one later, add its id to
 * ENABLED_METHODS and (if needed) wire its gateway in server.js.
 */

const COD = "cod";

// Methods the server will accept when creating an order.
const ENABLED_METHODS = [COD];

// Methods shown in the UI but not selectable yet.
const KNOWN_ONLINE_METHODS = ["card", "visa", "mastercard", "paypal"];

const ALIASES = {
  cod: COD,
  cash: COD,
  cash_on_delivery: COD,
  "cash-on-delivery": COD,
};

function normalizeMethod(v) {
  const k = String(v == null ? "" : v).trim().toLowerCase();
  if (!k) return COD; // legacy clients that send no method => COD
  return ALIASES[k] || k;
}

/** @returns {{ok:true, method:string} | {ok:false, error:string, code:string, method:string}} */
function resolvePaymentMethod(raw, opts = {}) {
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return {
      ok: false,
      code: "PAYMENT_METHOD_NOT_AVAILABLE",
      error: "Payment method not available",
      method: "",
    };
  }
  const s = String(raw == null ? "" : raw);
  if (s.length > 80) {
    return {
      ok: false,
      code: "PAYMENT_METHOD_NOT_AVAILABLE",
      error: "Payment method not available",
      method: s.slice(0, 40),
    };
  }
  const method = normalizeMethod(raw);
  if (ENABLED_METHODS.includes(method)) return { ok: true, method };
  if (opts && opts.allowWallet && method === "wallet") {
    return { ok: true, method: "wallet" };
  }
  if (opts && opts.allowElectronic && ["card", "electronic", "online", "cmi", "visa", "mastercard"].includes(method)) {
    return { ok: true, method: "electronic" };
  }
  return {
    ok: false,
    code: "PAYMENT_METHOD_NOT_AVAILABLE",
    error: "Payment method not available",
    method: method.slice(0, 40),
  };
}

module.exports = { COD, ENABLED_METHODS, KNOWN_ONLINE_METHODS, normalizeMethod, resolvePaymentMethod };
