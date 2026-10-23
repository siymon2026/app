"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../lib/payments");

test("COD is accepted (explicit, alias, and legacy missing method)", () => {
  for (const v of ["cod", "COD", " cash_on_delivery ", "cash", undefined, null, ""]) {
    const r = p.resolvePaymentMethod(v);
    assert.equal(r.ok, true, String(v));
    assert.equal(r.method, "cod");
  }
});
test("online methods are rejected until enabled", () => {
  for (const v of ["card", "visa", "mastercard", "paypal", "stripe", "Visa"]) {
    const r = p.resolvePaymentMethod(v);
    assert.equal(r.ok, false, v);
    assert.equal(r.code, "PAYMENT_METHOD_NOT_AVAILABLE");
  }
});
test("garbage input is rejected, not coerced to COD", () => {
  assert.equal(p.resolvePaymentMethod("x".repeat(500)).ok, false);
  assert.equal(p.resolvePaymentMethod({}).ok, false);
});
test("only COD is enabled; all UI online methods are known", () => {
  assert.deepEqual(p.ENABLED_METHODS, ["cod"]);
  for (const m of ["card", "visa", "mastercard", "paypal"]) assert.ok(p.KNOWN_ONLINE_METHODS.includes(m));
});
