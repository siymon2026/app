"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const finance = require("../lib/finance-wallet");
const ops = require("../lib/exceptions-moderation-reports");

test("SIYMON customer wallet enforces idempotency, balance checks, and split payment planning", () => {
  const state = finance.ensureWalletState({});

  // Credit customer wallet (confirmed top-up)
  const top = finance.recordWalletTransaction(state, {
    customerId: "cust_1",
    type: "topup",
    direction: "credit",
    amount: 60,
    referenceId: "TOP-100",
    idempotencyKey: "topup:TOP-100",
  });
  assert.equal(top.ok, true);
  assert.equal(finance.getCustomerWalletBalance(state, "cust_1"), 60);

  // Plan split payment for a 95 MAD order using 60 MAD wallet + 35 MAD COD
  const plan = finance.planOrderPayment({
    total: 95,
    walletBalance: 60,
    useWallet: true,
    paymentMethod: "cod",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.walletUsed, 60);
  assert.equal(plan.remainingDue, 35);
  assert.equal(plan.secondaryMethod, "cod");

  // Debit wallet with idempotency key
  const d1 = finance.recordWalletTransaction(state, {
    customerId: "cust_1",
    type: "order_payment",
    direction: "debit",
    amount: 60,
    referenceId: "ord_1",
    idempotencyKey: "order_debit:ord_1",
  });
  assert.equal(d1.ok, true);
  assert.equal(d1.balance, 0);

  // Duplicate debit with same idempotencyKey does not double-spend
  const d2 = finance.recordWalletTransaction(state, {
    customerId: "cust_1",
    type: "order_payment",
    direction: "debit",
    amount: 60,
    referenceId: "ord_1",
    idempotencyKey: "order_debit:ord_1",
  });
  assert.equal(d2.ok, true);
  assert.equal(d2.idempotentReplay, true);
  assert.equal(finance.getCustomerWalletBalance(state, "cust_1"), 0);
});

test("electronic payment webhook verifies HMAC signature and marks payment intent succeeded once", () => {
  const state = finance.ensureWalletState({});
  const secret = "webhook-secret-xyz";
  const intent = finance.createElectronicPaymentIntent(state, {
    orderId: "ord_200",
    customerId: "cust_2",
    amount: 120,
  });

  const payloadObj = {
    intentId: intent.id,
    orderId: "ord_200",
    status: "succeeded",
    providerReference: "GW-REF-1",
  };
  const rawPayload = JSON.stringify(payloadObj);
  const sig = crypto.createHmac("sha256", secret).update(rawPayload, "utf8").digest("hex");

  const badSig = finance.verifyElectronicPaymentWebhook(state, {
    ...payloadObj,
    rawPayload,
    signature: "bad",
    webhookSecret: secret,
  });
  assert.equal(badSig.ok, false);
  assert.equal(badSig.error, "invalid_webhook_signature");

  const okHook = finance.verifyElectronicPaymentWebhook(state, {
    ...payloadObj,
    rawPayload,
    signature: sig,
    webhookSecret: secret,
  });
  assert.equal(okHook.ok, true);
  assert.equal(okHook.intent.status, "succeeded");

  // Replay of same webhook is idempotent
  const replay = finance.verifyElectronicPaymentWebhook(state, {
    ...payloadObj,
    rawPayload,
    signature: sig,
    webhookSecret: secret,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);
});

test("promotions, commissions, financial snapshots, settlements, and refunds work end-to-end", () => {
  const coupons = [
    {
      id: "prm_1",
      code: "WELCOME20",
      isActive: true,
      discountType: "percent",
      value: 20,
      maxDiscount: 30,
      minOrder: 50,
      firstOrderOnly: true,
      costBearer: "split",
      storeSplitPct: 50,
    },
  ];
  const evalPromo = finance.evaluatePromotion({
    coupons,
    couponCode: "WELCOME20",
    customerId: "c1",
    storeId: "s1",
    subtotal: 100,
    deliveryFee: 15,
    customerPriorOrdersCount: 0,
  });
  assert.equal(evalPromo.ok, true);
  assert.equal(evalPromo.itemDiscount, 20);
  assert.equal(evalPromo.storeBorneDiscount, 10);
  assert.equal(evalPromo.platformBorneDiscount, 10);

  const snap = finance.computeOrderFinancialSnapshot({
    subtotal: 100,
    deliveryFee: 15,
    store: { id: "s1", commissionPct: 15, commissionFixed: 2 },
    promoResult: evalPromo,
    driverEarningsSnapshot: { totalEarnings: 12 },
    paymentPlan: { walletUsed: 50, codCollectable: 45, electronicDue: 0 },
  });
  assert.equal(snap.finalTotal, 95); // (100 - 20) + 15
  // commissionableBase = 100 - 10 (storeBorneDiscount) = 90; 15% of 90 + 2 = 13.5 + 2 = 15.5
  assert.equal(snap.platformCommission, 15.5);
  assert.equal(snap.netMerchantPayable, 74.5); // 90 - 15.5

  // Manual settlement prevents double-settling the same order
  const state = finance.ensureWalletState({});
  const orders = [{ id: "ord_s1", restaurantId: "s1", customerId: "c1", status: "delivered", total: 95, financialSnapshot: snap }];
  const stl1 = finance.createManualSettlement(state, {
    targetType: "store",
    targetId: "s1",
    orders,
    method: "bank_transfer",
    reference: "BANK-TX-01",
    actorId: "acc_1",
  });
  assert.equal(stl1.ok, true);
  assert.equal(stl1.settlement.netPayout, 74.5);

  const stlDup = finance.createManualSettlement(state, {
    targetType: "store",
    targetId: "s1",
    orders,
    actorId: "acc_1",
  });
  assert.equal(stlDup.ok, false);
  assert.equal(stlDup.error, "no_unsettled_delivered_orders");

  // Authorized refund to wallet prevents duplicate full refunds
  const ref1 = finance.processAuthorizedRefund(state, {
    order: orders[0],
    amount: 95,
    destination: "wallet",
    reason: "Damaged item refund approved",
    actorId: "sup_1",
  });
  assert.equal(ref1.ok, true);
  assert.equal(finance.getCustomerWalletBalance(state, "c1"), 95);

  const refDup = finance.processAuthorizedRefund(state, {
    order: orders[0],
    amount: 10,
    destination: "wallet",
    reason: "Duplicate attempt",
    actorId: "sup_1",
  });
  assert.equal(refDup.ok, false);
  assert.equal(refDup.error, "order_already_fully_refunded");
});

test("Supervisor Exception Center, comment moderation, complaint escalation, and CSV/Excel/PDF exports", () => {
  const state = ops.ensureExceptionsState({});
  const ex = ops.createExceptionCase(state, {
    category: "failed_delivery",
    severity: "high",
    orderId: "ord_55",
    restaurantId: "s1",
    title: "Customer unreachable at door",
  });
  assert.equal(ex.ok, true);

  const res = ops.resolveExceptionCase(state, {
    caseId: ex.exceptionCase.id,
    decision: "redelivery_scheduled",
    notes: "Contacted customer; scheduled redelivery with new fee",
    supervisorId: "sup_1",
  });
  assert.equal(res.ok, true);
  assert.equal(res.exceptionCase.status, "resolved");

  // Rating moderation: unapproved comments are hidden from public summary while stars count in average
  const orders = [
    { id: "o1", restaurantId: "s1", status: "delivered", subtotal: 90, deliveryFee: 10, total: 100, customerRating: { stars: 5, comment: "Great food!", moderationStatus: "approved", createdAt: new Date().toISOString() }, createdAt: new Date().toISOString() },
    { id: "o2", restaurantId: "s1", status: "delivered", subtotal: 70, deliveryFee: 10, total: 80, customerRating: { stars: 3, comment: "Hidden until moderated", moderationStatus: "pending_moderation", createdAt: new Date().toISOString() }, createdAt: new Date().toISOString() },
  ];
  const pubSum = ops.computePublicRatingsSummary(orders, { targetType: "store", targetId: "s1" });
  assert.equal(pubSum.count, 2);
  assert.equal(pubSum.averageStars, 4);
  assert.equal(pubSum.reviews.length, 1);
  assert.equal(pubSum.reviews[0].comment, "Great food!");

  // Complaint routing to store first, then escalation to supervisor exception center
  const cmp = ops.createComplaint(state, {
    orderId: "o1",
    customerId: "c1",
    restaurantId: "s1",
    targetType: "store",
    category: "missing_item",
    description: "Missing drink in my order",
  });
  assert.equal(cmp.ok, true);
  assert.equal(cmp.complaint.stage, "target_review");

  const esc = ops.escalateComplaintToSupervisor(state, {
    complaintId: cmp.complaint.id,
    reason: "Customer requests refund review by supervisor",
    actorType: "store",
  });
  assert.equal(esc.ok, true);
  assert.equal(esc.complaint.stage, "supervisor_escalated");

  // Reports & Exports (CSV, Excel XML, PDF 1.4)
  const rep = ops.buildReport({
    orders,
    settlements: [],
    period: "daily",
  });
  assert.equal(rep.summary.totalOrders, 2);

  const csv = ops.exportReportToCsv(rep);
  assert.match(csv, /orderId,createdAt/);

  const xls = ops.exportReportToExcelXml(rep);
  assert.match(xls, /<Workbook/);

  const pdf = ops.exportReportToPdfBuffer(rep);
  assert.equal(Buffer.isBuffer(pdf), true);
  assert.match(pdf.toString("latin1", 0, 16), /^%PDF-1\.4/);
});
