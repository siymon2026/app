"use strict";
/**
 * SIYMON Customer Wallet Ledger, Split Payments, Electronic Payment Verification,
 * Per-Business Commissions, Manual Settlements, Authorized Refunds,
 * and Promotions / Loyalty / Referrals (Sections 11, 12)
 */
const crypto = require("crypto");

function roundMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function ensureWalletState(state) {
  if (!state || typeof state !== "object") state = {};
  if (!state.balances || typeof state.balances !== "object") state.balances = {};
  if (!Array.isArray(state.entries)) state.entries = [];
  if (!state.idempotency || typeof state.idempotency !== "object") state.idempotency = {};
  if (!state.loyalty || typeof state.loyalty !== "object") state.loyalty = {};
  if (!state.referrals || typeof state.referrals !== "object") state.referrals = {};
  if (!Array.isArray(state.refunds)) state.refunds = [];
  if (!Array.isArray(state.settlements)) state.settlements = [];
  if (!Array.isArray(state.paymentIntents)) state.paymentIntents = [];
  return state;
}

function getCustomerWalletBalance(state, customerId) {
  ensureWalletState(state);
  const key = String(customerId || "");
  return roundMoney(state.balances[key] || 0);
}

/**
 * Append an immutable, idempotent ledger entry and update customer wallet balance.
 */
function recordWalletTransaction(
  state,
  {
    customerId,
    type,
    direction,
    amount,
    referenceId = null,
    idempotencyKey = null,
    actorType = "system",
    actorId = null,
    reason = "",
    now = new Date().toISOString(),
  }
) {
  ensureWalletState(state);
  const cid = String(customerId || "").trim();
  if (!cid) return { ok: false, status: 400, error: "customer_id_required" };

  const cleanAmount = roundMoney(amount);
  if (!(cleanAmount > 0)) {
    return { ok: false, status: 400, error: "invalid_wallet_amount" };
  }
  if (direction !== "credit" && direction !== "debit") {
    return { ok: false, status: 400, error: "invalid_direction" };
  }
  if (type === "admin_adjustment" && String(reason || "").trim().length < 3) {
    return { ok: false, status: 400, error: "adjustment_reason_required" };
  }

  // Idempotency check to prevent double-spend / duplicate credits
  if (idempotencyKey) {
    const ik = `${cid}:${String(idempotencyKey)}`;
    const existingId = state.idempotency[ik];
    if (existingId) {
      const existingEntry = state.entries.find((e) => e.id === existingId);
      if (existingEntry) {
        return {
          ok: true,
          idempotentReplay: true,
          entry: existingEntry,
          balance: getCustomerWalletBalance(state, cid),
        };
      }
    }
  }

  const before = getCustomerWalletBalance(state, cid);
  if (direction === "debit" && before < cleanAmount) {
    return {
      ok: false,
      status: 402,
      error: "insufficient_wallet_balance",
      balance: before,
      required: cleanAmount,
    };
  }

  const after = direction === "credit" ? roundMoney(before + cleanAmount) : roundMoney(before - cleanAmount);
  const entry = {
    id: "WLT-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
    customerId: cid,
    type: String(type || "adjustment"),
    direction,
    amount: cleanAmount,
    balanceBefore: before,
    balanceAfter: after,
    referenceId: referenceId ? String(referenceId) : null,
    idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
    actorType: String(actorType || "system"),
    actorId: actorId ? String(actorId) : null,
    reason: String(reason || "").slice(0, 300),
    createdAt: now,
  };

  state.balances[cid] = after;
  state.entries.unshift(entry);
  if (idempotencyKey) {
    state.idempotency[`${cid}:${String(idempotencyKey)}`] = entry.id;
  }

  return { ok: true, entry, balance: after };
}

/**
 * Plan and validate full or partial wallet payment + remaining payment method (COD or electronic).
 */
function planOrderPayment({
  total,
  walletBalance = 0,
  useWallet = false,
  requestedWalletAmount = null,
  paymentMethod = "cod",
  electronicEnabled = false,
}) {
  const orderTotal = roundMoney(total);
  if (orderTotal < 0) return { ok: false, status: 400, error: "invalid_order_total" };

  const method = String(paymentMethod || "cod").trim().toLowerCase();
  let walletUsed = 0;

  if (useWallet || method === "wallet") {
    const avail = Math.max(0, roundMoney(walletBalance));
    const desired =
      requestedWalletAmount !== null && requestedWalletAmount !== undefined
        ? roundMoney(requestedWalletAmount)
        : orderTotal;
    if (desired < 0) {
      return { ok: false, status: 400, error: "invalid_wallet_amount" };
    }
    walletUsed = Math.min(orderTotal, avail, desired);
    if (method === "wallet" && walletUsed < orderTotal) {
      return {
        ok: false,
        status: 402,
        error: "insufficient_wallet_balance_for_full_payment",
        walletBalance: avail,
        orderTotal,
      };
    }
  }

  const remainingDue = roundMoney(orderTotal - walletUsed);
  let secondaryMethod = null;
  if (remainingDue > 0) {
    if (["cod", "cash", "cash_on_delivery", "wallet"].includes(method)) {
      secondaryMethod = "cod";
    } else if (["card", "electronic", "online", "cmi", "stripe"].includes(method)) {
      if (!electronicEnabled) {
        return {
          ok: false,
          status: 422,
          error: "electronic_payment_not_enabled",
          code: "PAYMENT_METHOD_NOT_AVAILABLE",
        };
      }
      secondaryMethod = "electronic";
    } else {
      return { ok: false, status: 400, error: "unsupported_payment_method" };
    }
  }

  const primaryMethod =
    walletUsed >= orderTotal
      ? "wallet"
      : walletUsed > 0
      ? `wallet+${secondaryMethod}`
      : secondaryMethod || "cod";

  return {
    ok: true,
    orderTotal,
    walletUsed,
    remainingDue,
    primaryMethod,
    secondaryMethod,
    codCollectable: secondaryMethod === "cod" ? remainingDue : 0,
    electronicDue: secondaryMethod === "electronic" ? remainingDue : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Electronic Payment Intents & Webhook Verification (Section 11)
 * ------------------------------------------------------------------ */

function createElectronicPaymentIntent(state, { orderId, customerId, amount, provider = "cmi_gateway", now = new Date().toISOString() }) {
  ensureWalletState(state);
  const intent = {
    id: "PAY-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
    orderId: String(orderId),
    customerId: customerId ? String(customerId) : null,
    amount: roundMoney(amount),
    currency: "MAD",
    provider: String(provider),
    status: "pending",
    providerReference: null,
    createdAt: now,
    verifiedAt: null,
  };
  state.paymentIntents.unshift(intent);
  return intent;
}

function verifyElectronicPaymentWebhook(
  state,
  { intentId, orderId, status, providerReference, signature, rawPayload, webhookSecret, now = new Date().toISOString() }
) {
  ensureWalletState(state);
  if (!webhookSecret) {
    return { ok: false, status: 503, error: "webhook_secret_not_configured" };
  }
  const payloadStr = typeof rawPayload === "string" ? rawPayload : JSON.stringify({ intentId, orderId, status, providerReference });
  const expectedSig = crypto.createHmac("sha256", String(webhookSecret)).update(payloadStr, "utf8").digest("hex");
  const sigBuf = Buffer.from(String(signature || ""), "hex");
  const expBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, status: 401, error: "invalid_webhook_signature" };
  }

  const intent = state.paymentIntents.find(
    (p) => (intentId && p.id === String(intentId)) || (orderId && p.orderId === String(orderId))
  );
  if (!intent) {
    return { ok: false, status: 404, error: "payment_intent_not_found" };
  }
  if (intent.status === "succeeded") {
    return { ok: true, idempotentReplay: true, intent };
  }
  intent.status = status === "succeeded" || status === "paid" ? "succeeded" : "failed";
  intent.providerReference = providerReference ? String(providerReference) : intent.providerReference;
  intent.verifiedAt = now;
  return { ok: true, intent };
}

/* ------------------------------------------------------------------ *
 * Promotions, Coupons, First-Order Discounts & Loyalty (Section 12)
 * ------------------------------------------------------------------ */

function evaluatePromotion({
  couponCode,
  coupons = [],
  subtotal = 0,
  deliveryFee = 0,
  storeId = null,
  customerId = null,
  customerPriorOrdersCount = 0,
  firstOrderPromo = null,
  now = Date.now(),
}) {
  const cleanSubtotal = roundMoney(subtotal);
  const cleanDelivery = roundMoney(deliveryFee);

  // 1. Explicit coupon code
  if (couponCode && String(couponCode).trim()) {
    const code = String(couponCode).trim().toUpperCase();
    const coupon = (Array.isArray(coupons) ? coupons : []).find(
      (c) => c && String(c.code || "").trim().toUpperCase() === code
    );
    if (!coupon || coupon.isActive === false) {
      return { ok: false, status: 400, error: "invalid_coupon_code" };
    }
    if (coupon.storeId && storeId && String(coupon.storeId) !== String(storeId)) {
      return { ok: false, status: 400, error: "coupon_not_valid_for_store" };
    }
    if (coupon.startsAt && now < Date.parse(coupon.startsAt)) {
      return { ok: false, status: 400, error: "coupon_not_started" };
    }
    if (coupon.endsAt && now > Date.parse(coupon.endsAt)) {
      return { ok: false, status: 400, error: "coupon_expired" };
    }
    if (Number(coupon.minOrder) > 0 && cleanSubtotal < Number(coupon.minOrder)) {
      return {
        ok: false,
        status: 400,
        error: "coupon_min_order_not_met",
        minOrder: Number(coupon.minOrder),
      };
    }
    if (Number(coupon.maxUses) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) {
      return { ok: false, status: 400, error: "coupon_usage_limit_reached" };
    }
    if (coupon.firstOrderOnly && customerPriorOrdersCount > 0) {
      return { ok: false, status: 400, error: "coupon_first_order_only" };
    }
    if (customerId && Number(coupon.maxUsesPerCustomer) > 0 && coupon.usedBy && Number(coupon.usedBy[customerId] || 0) >= Number(coupon.maxUsesPerCustomer)) {
      return { ok: false, status: 400, error: "coupon_customer_limit_reached" };
    }

    let itemDiscount = 0;
    let deliveryDiscount = 0;
    const dtype = String(coupon.discountType || "percent").toLowerCase();
    if (dtype === "free_delivery" || dtype === "delivery_discount") {
      const pct = Number(coupon.value || 100);
      deliveryDiscount = roundMoney(Math.min(cleanDelivery, (cleanDelivery * Math.min(100, Math.max(0, pct))) / 100));
    } else if (dtype === "fixed") {
      itemDiscount = roundMoney(Math.min(cleanSubtotal, Math.max(0, Number(coupon.value || 0))));
    } else {
      const pct = Math.min(100, Math.max(0, Number(coupon.value || 0)));
      itemDiscount = roundMoney((cleanSubtotal * pct) / 100);
    }
    if (Number(coupon.maxDiscount) > 0) {
      itemDiscount = Math.min(itemDiscount, roundMoney(coupon.maxDiscount));
    }

    const totalDiscount = roundMoney(itemDiscount + deliveryDiscount);
    const costBearer = ["platform", "store", "split"].includes(coupon.costBearer) ? coupon.costBearer : "platform";
    const storeSplitRatio = costBearer === "store" ? 1 : costBearer === "split" ? Math.min(1, Math.max(0, Number(coupon.storeSplitPct ?? 50) / 100)) : 0;
    const storeBorneDiscount = roundMoney(itemDiscount * storeSplitRatio);
    const platformBorneDiscount = roundMoney(totalDiscount - storeBorneDiscount);

    return {
      ok: true,
      applied: true,
      promoType: "coupon",
      code: coupon.code,
      couponId: coupon.id || coupon.code,
      itemDiscount,
      deliveryDiscount,
      totalDiscount,
      costBearer,
      storeBorneDiscount,
      platformBorneDiscount,
    };
  }

  // 2. Automatic First-Order Discount if enabled and customer has 0 prior non-canceled orders
  if (firstOrderPromo && firstOrderPromo.enabled && customerId && customerPriorOrdersCount === 0) {
    const minOrd = Number(firstOrderPromo.minOrder || 0);
    if (cleanSubtotal >= minOrd) {
      const pct = Math.min(100, Math.max(0, Number(firstOrderPromo.percent || 0)));
      const fixed = Math.max(0, Number(firstOrderPromo.fixed || 0));
      let itemDiscount = pct > 0 ? roundMoney((cleanSubtotal * pct) / 100) : roundMoney(Math.min(cleanSubtotal, fixed));
      if (Number(firstOrderPromo.maxDiscount) > 0) {
        itemDiscount = Math.min(itemDiscount, roundMoney(firstOrderPromo.maxDiscount));
      }
      if (itemDiscount > 0) {
        return {
          ok: true,
          applied: true,
          promoType: "first_order",
          code: "FIRST_ORDER",
          itemDiscount,
          deliveryDiscount: 0,
          totalDiscount: itemDiscount,
          costBearer: "platform",
          storeBorneDiscount: 0,
          platformBorneDiscount: itemDiscount,
        };
      }
    }
  }

  return {
    ok: true,
    applied: false,
    promoType: null,
    code: null,
    itemDiscount: 0,
    deliveryDiscount: 0,
    totalDiscount: 0,
    costBearer: "platform",
    storeBorneDiscount: 0,
    platformBorneDiscount: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Per-Order Commission & Financial Snapshot (Section 11)
 * ------------------------------------------------------------------ */

function computeOrderFinancialSnapshot({
  subtotal,
  deliveryFee,
  promoResult = null,
  store = null,
  defaultCommissionPct = 10,
  defaultCommissionFixed = 0,
  driverEarningsSnapshot = null,
  paymentPlan = null,
}) {
  const grossSubtotal = roundMoney(subtotal);
  const grossDeliveryFee = roundMoney(deliveryFee);
  const itemDiscount = roundMoney(promoResult?.itemDiscount || 0);
  const deliveryDiscount = roundMoney(promoResult?.deliveryDiscount || 0);
  const totalDiscount = roundMoney(itemDiscount + deliveryDiscount);
  const storeBorneDiscount = roundMoney(promoResult?.storeBorneDiscount || 0);
  const platformBorneDiscount = roundMoney(promoResult?.platformBorneDiscount || 0);

  const netSubtotal = roundMoney(Math.max(0, grossSubtotal - itemDiscount));
  const netDeliveryFee = roundMoney(Math.max(0, grossDeliveryFee - deliveryDiscount));
  const finalTotal = roundMoney(netSubtotal + netDeliveryFee);

  const commPct =
    store && Number.isFinite(Number(store.commissionPct))
      ? Math.max(0, Math.min(100, Number(store.commissionPct)))
      : Math.max(0, Math.min(100, Number(defaultCommissionPct || 0)));
  const commFixed =
    store && Number.isFinite(Number(store.commissionFixed))
      ? Math.max(0, Number(store.commissionFixed))
      : Math.max(0, Number(defaultCommissionFixed || 0));

  // Commission is calculated on the merchant's effective subtotal (grossSubtotal - storeBorneDiscount)
  const commissionableBase = roundMoney(Math.max(0, grossSubtotal - storeBorneDiscount));
  const platformCommission = roundMoney((commissionableBase * commPct) / 100 + (grossSubtotal > 0 ? commFixed : 0));
  const netMerchantPayable = roundMoney(Math.max(0, commissionableBase - platformCommission));
  const driverPayable = roundMoney(driverEarningsSnapshot?.totalEarnings ?? grossDeliveryFee);

  return {
    grossSubtotal,
    grossDeliveryFee,
    itemDiscount,
    deliveryDiscount,
    totalDiscount,
    promoCode: promoResult?.code || null,
    promoCostBearer: promoResult?.costBearer || "platform",
    storeBorneDiscount,
    platformBorneDiscount,
    netSubtotal,
    netDeliveryFee,
    finalTotal,
    commissionPct: commPct,
    commissionFixed: commFixed,
    platformCommission,
    netMerchantPayable,
    driverPayable,
    walletPaid: roundMoney(paymentPlan?.walletUsed || 0),
    electronicDue: roundMoney(paymentPlan?.electronicDue || 0),
    codCollectable: roundMoney(paymentPlan?.codCollectable ?? finalTotal),
    snapshottedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Manual Settlements & Authorized Refunds (Section 11)
 * ------------------------------------------------------------------ */

function createManualSettlement(
  state,
  {
    targetType = "store",
    targetId,
    orders = [],
    method = "cash",
    reference = "",
    note = "",
    actorId,
    now = new Date().toISOString(),
  }
) {
  ensureWalletState(state);
  if (!["store", "driver"].includes(targetType)) {
    return { ok: false, status: 400, error: "invalid_settlement_target_type" };
  }
  const tid = String(targetId || "").trim();
  if (!tid) return { ok: false, status: 400, error: "target_id_required" };

  const eligibleOrders = orders.filter((o) => {
    if (!o || !["delivered", "done"].includes(String(o.status || "").toLowerCase())) return false;
    if (targetType === "store") {
      return String(o.restaurantId || "") === tid && !o.storeSettlementId;
    }
    return String(o.driverId || "") === tid && !o.driverSettlementId;
  });

  if (eligibleOrders.length === 0) {
    return { ok: false, status: 409, error: "no_unsettled_delivered_orders" };
  }

  let grossAmount = 0;
  let totalCommission = 0;
  let netPayout = 0;

  for (const o of eligibleOrders) {
    const snap = o.financialSnapshot || {};
    if (targetType === "store") {
      const sub = roundMoney(snap.grossSubtotal ?? o.subtotal ?? o.total ?? 0);
      const comm = roundMoney(snap.platformCommission ?? 0);
      const net = roundMoney(snap.netMerchantPayable ?? Math.max(0, sub - comm));
      grossAmount = roundMoney(grossAmount + sub);
      totalCommission = roundMoney(totalCommission + comm);
      netPayout = roundMoney(netPayout + net);
    } else {
      const earn = roundMoney(
        o.driverEarningsSnapshot?.totalEarnings ?? snap.driverPayable ?? o.deliveryFee ?? 0
      );
      grossAmount = roundMoney(grossAmount + earn);
      netPayout = roundMoney(netPayout + earn);
    }
  }

  const settlementId = "STL-" + crypto.randomBytes(5).toString("hex").toUpperCase();
  for (const o of eligibleOrders) {
    if (targetType === "store") {
      o.storeSettlementId = settlementId;
      o.storeSettledAt = now;
    } else {
      o.driverSettlementId = settlementId;
      o.driverSettledAt = now;
    }
  }

  const record = {
    id: settlementId,
    targetType,
    targetId: tid,
    orderIds: eligibleOrders.map((o) => o.id),
    orderCount: eligibleOrders.length,
    grossAmount,
    totalCommission,
    netPayout,
    method: String(method || "cash").slice(0, 40),
    reference: String(reference || "").slice(0, 100),
    note: String(note || "").slice(0, 300),
    createdBy: String(actorId || "admin"),
    createdAt: now,
  };
  state.settlements.unshift(record);
  return { ok: true, settlement: record };
}

/**
 * Process an authorized refund with duplicate/over-refund prevention.
 */
function processAuthorizedRefund(
  state,
  {
    order,
    amount = null,
    destination = "wallet", // "wallet" | "original"
    reason = "",
    actorId,
    actorRole = "admin",
    now = new Date().toISOString(),
  }
) {
  ensureWalletState(state);
  if (!order || !order.id) return { ok: false, status: 404, error: "order_not_found" };
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 3) {
    return { ok: false, status: 400, error: "refund_reason_required" };
  }

  const orderTotal = roundMoney(order.total || 0);
  const alreadyRefunded = roundMoney(order.refundedAmount || 0);
  const refundableRemaining = roundMoney(Math.max(0, orderTotal - alreadyRefunded));
  if (refundableRemaining <= 0) {
    return { ok: false, status: 409, error: "order_already_fully_refunded" };
  }

  const refundAmount = amount !== null && amount !== undefined ? roundMoney(amount) : refundableRemaining;
  if (!(refundAmount > 0) || refundAmount > refundableRemaining) {
    return {
      ok: false,
      status: 400,
      error: "invalid_refund_amount",
      refundableRemaining,
    };
  }

  const refundId = "RFD-" + crypto.randomBytes(5).toString("hex").toUpperCase();
  let walletTx = null;
  if (destination === "wallet") {
    if (!order.customerId) {
      return { ok: false, status: 400, error: "order_has_no_customer_for_wallet_refund" };
    }
    const txRes = recordWalletTransaction(state, {
      customerId: order.customerId,
      type: "refund",
      direction: "credit",
      amount: refundAmount,
      referenceId: order.id,
      idempotencyKey: `refund:${order.id}:${alreadyRefunded}:${refundAmount}`,
      actorType: actorRole,
      actorId,
      reason: cleanReason,
      now,
    });
    if (!txRes.ok) return txRes;
    walletTx = txRes.entry;
  }

  order.refundedAmount = roundMoney(alreadyRefunded + refundAmount);
  order.status = order.refundedAmount >= orderTotal ? "refund_completed" : "refund_pending";
  order.refundedAt = now;

  const refundRecord = {
    id: refundId,
    orderId: order.id,
    customerId: order.customerId || null,
    restaurantId: order.restaurantId || null,
    amount: refundAmount,
    destination,
    walletTransactionId: walletTx ? walletTx.id : null,
    reason: cleanReason,
    approvedBy: String(actorId || "admin"),
    createdAt: now,
  };
  state.refunds.unshift(refundRecord);
  return { ok: true, refund: refundRecord, walletTransaction: walletTx };
}

/* ------------------------------------------------------------------ *
 * Loyalty Points & Referrals (Section 12)
 * ------------------------------------------------------------------ */

function awardLoyaltyForDeliveredOrder(state, { order, pointsPerMad = 1, now = new Date().toISOString() }) {
  ensureWalletState(state);
  if (!order || !order.customerId || order.loyaltyAwardedAt) {
    return { ok: false, skipped: true };
  }
  const cid = String(order.customerId);
  const pts = Math.max(0, Math.floor(Number(order.total || 0) * Number(pointsPerMad || 1)));
  if (pts <= 0) return { ok: false, skipped: true };
  const rec = state.loyalty[cid] || { points: 0, totalEarned: 0, totalRedeemed: 0, history: [] };
  rec.points += pts;
  rec.totalEarned += pts;
  rec.history.unshift({
    id: "LYL-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
    type: "earn",
    points: pts,
    orderId: order.id,
    at: now,
  });
  state.loyalty[cid] = rec;
  order.loyaltyAwardedAt = now;
  order.loyaltyPointsEarned = pts;
  return { ok: true, pointsEarned: pts, totalPoints: rec.points };
}

function redeemLoyaltyPointsToWallet(state, { customerId, points, pointsPerMadRedeem = 10, now = new Date().toISOString() }) {
  ensureWalletState(state);
  const cid = String(customerId || "").trim();
  const pts = Math.floor(Number(points || 0));
  if (!cid || pts <= 0) return { ok: false, status: 400, error: "invalid_points" };
  const rec = state.loyalty[cid] || { points: 0, totalEarned: 0, totalRedeemed: 0, history: [] };
  if (rec.points < pts) {
    return { ok: false, status: 400, error: "insufficient_loyalty_points", availablePoints: rec.points };
  }
  const madCredit = roundMoney(pts / Math.max(1, Number(pointsPerMadRedeem || 10)));
  if (madCredit <= 0) return { ok: false, status: 400, error: "points_below_minimum_redemption" };

  rec.points -= pts;
  rec.totalRedeemed += pts;
  const histId = "LYL-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  rec.history.unshift({ id: histId, type: "redeem", points: -pts, walletCredit: madCredit, at: now });
  state.loyalty[cid] = rec;

  const wRes = recordWalletTransaction(state, {
    customerId: cid,
    type: "loyalty_reward",
    direction: "credit",
    amount: madCredit,
    referenceId: histId,
    idempotencyKey: `loyalty_redeem:${histId}`,
    actorType: "customer",
    actorId: cid,
    reason: `Redeemed ${pts} loyalty points`,
    now,
  });
  return { ok: true, pointsRedeemed: pts, remainingPoints: rec.points, walletCredit: madCredit, walletBalance: wRes.balance };
}

module.exports = {
  roundMoney,
  ensureWalletState,
  getCustomerWalletBalance,
  recordWalletTransaction,
  planOrderPayment,
  createElectronicPaymentIntent,
  verifyElectronicPaymentWebhook,
  evaluatePromotion,
  computeOrderFinancialSnapshot,
  createManualSettlement,
  processAuthorizedRefund,
  awardLoyaltyForDeliveredOrder,
  redeemLoyaltyPointsToWallet,
};
