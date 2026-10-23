"use strict";
/**
 * Unified Supervisor Exception Center (Section 14),
 * Rating Comment Moderation & Complaint Escalation (Section 16),
 * Role-Specific Financial/Operational Reports with Excel & PDF Export (Section 17),
 * and Real System Health Monitoring (Section 22)
 */
const crypto = require("crypto");
const { roundMoney } = require("./finance-wallet");

/* ------------------------------------------------------------------ *
 * Section 14 — Unified Exception & Problem Management Center
 * ------------------------------------------------------------------ */

const EXCEPTION_CATEGORIES = [
  "delayed_preparation",
  "rejected_order",
  "unassigned_order",
  "driver_failure",
  "failed_delivery",
  "cancellation_refund_request",
  "complaint_dispute",
  "payment_reconciliation",
  "verification_override",
];

function ensureExceptionsState(state) {
  if (!state || typeof state !== "object") state = {};
  if (!Array.isArray(state.cases)) state.cases = [];
  if (!Array.isArray(state.complaints)) state.complaints = [];
  return state;
}

function createExceptionCase(
  state,
  {
    category,
    severity = "high", // "low" | "medium" | "high" | "critical"
    orderId = null,
    restaurantId = null,
    driverId = null,
    customerId = null,
    title = "",
    description = "",
    meta = {},
    createdBy = "system",
    now = new Date().toISOString(),
  }
) {
  ensureExceptionsState(state);
  const cat = EXCEPTION_CATEGORIES.includes(category) ? category : "unassigned_order";

  // Deduplicate open exception for the same (category, orderId)
  if (orderId) {
    const existing = state.cases.find(
      (c) => c.orderId === String(orderId) && c.category === cat && c.status !== "resolved"
    );
    if (existing) {
      existing.updatedAt = now;
      if (description) existing.description = String(description).slice(0, 500);
      return { ok: true, deduplicated: true, exceptionCase: existing };
    }
  }

  const item = {
    id: "EXC-" + crypto.randomBytes(5).toString("hex").toUpperCase(),
    category: cat,
    severity: ["low", "medium", "high", "critical"].includes(severity) ? severity : "high",
    status: "open", // "open" | "in_progress" | "resolved"
    orderId: orderId ? String(orderId) : null,
    restaurantId: restaurantId ? String(restaurantId) : null,
    driverId: driverId ? String(driverId) : null,
    customerId: customerId ? String(customerId) : null,
    title: String(title || cat).slice(0, 160),
    description: String(description || "").slice(0, 600),
    meta: meta && typeof meta === "object" ? meta : {},
    createdBy: String(createdBy || "system"),
    createdAt: now,
    updatedAt: now,
    resolution: null,
  };
  state.cases.unshift(item);
  return { ok: true, exceptionCase: item };
}

function resolveExceptionCase(
  state,
  {
    caseId,
    supervisorId,
    decision, // "resolved" | "reassigned" | "refunded" | "redelivery_scheduled" | "canceled" | "dismissed"
    notes = "",
    redeliveryOrderId = null,
    refundId = null,
    now = new Date().toISOString(),
  }
) {
  ensureExceptionsState(state);
  const c = state.cases.find((x) => x.id === String(caseId));
  if (!c) return { ok: false, status: 404, error: "exception_case_not_found" };
  const cleanNotes = String(notes || "").trim();
  if (cleanNotes.length < 3) {
    return { ok: false, status: 400, error: "resolution_notes_required" };
  }
  c.status = "resolved";
  c.updatedAt = now;
  c.resolution = {
    decision: String(decision || "resolved").slice(0, 60),
    notes: cleanNotes.slice(0, 600),
    resolvedBy: String(supervisorId || "admin"),
    resolvedAt: now,
    redeliveryOrderId: redeliveryOrderId ? String(redeliveryOrderId) : null,
    refundId: refundId ? String(refundId) : null,
  };
  return { ok: true, exceptionCase: c };
}

/**
 * Scan active orders and automatically surface delayed preparation, unassigned ready orders,
 * rejected orders pending review, and failed deliveries into the Exception Center.
 */
function syncAutomaticOrderExceptions(state, orders = [], nowMs = Date.now()) {
  ensureExceptionsState(state);
  const nowIso = new Date(nowMs).toISOString();
  for (const o of orders) {
    if (!o || !o.id) continue;
    const st = String(o.status || "").toLowerCase();

    // 1. Store rejected order -> must enter supervisor review
    if ((o.canceledBy === "store" || st === "rejected") && o.rejectionReviewStatus === "pending_review") {
      createExceptionCase(state, {
        category: "rejected_order",
        severity: "high",
        orderId: o.id,
        restaurantId: o.restaurantId,
        customerId: o.customerId,
        title: `Order ${o.id} rejected by business`,
        description: o.cancelReason || "Rejected by store — requires supervisor review",
        now: nowIso,
      });
    }

    // 2. Unassigned order waiting too long (> 5 min in restaurant_ready or driver_unavailable)
    if (st === "driver_unavailable" || (st === "restaurant_ready" && !o.driverId)) {
      const readySince = Date.parse(o.readyAt || o.updatedAt || o.createdAt || "");
      if (st === "driver_unavailable" || (Number.isFinite(readySince) && nowMs - readySince > 5 * 60 * 1000)) {
        createExceptionCase(state, {
          category: "unassigned_order",
          severity: "high",
          orderId: o.id,
          restaurantId: o.restaurantId,
          customerId: o.customerId,
          title: `Order ${o.id} ready without assigned driver`,
          description: st === "driver_unavailable" ? "No eligible driver accepted offer" : "Order waiting for driver assignment > 5 minutes",
          now: nowIso,
        });
      }
    }

    // 3. Delayed preparation
    if (st === "delayed" || (st === "admin_accepted" && o.storeAcceptedAt && o.expectedPrepMinutes)) {
      const accMs = Date.parse(o.storeAcceptedAt || "");
      const maxPrepMs = Number(o.expectedPrepMinutes || 30) * 60 * 1000;
      if (st === "delayed" || (Number.isFinite(accMs) && nowMs - accMs > maxPrepMs)) {
        createExceptionCase(state, {
          category: "delayed_preparation",
          severity: "medium",
          orderId: o.id,
          restaurantId: o.restaurantId,
          customerId: o.customerId,
          title: `Order ${o.id} preparation delayed`,
          description: o.delayReason || "Preparation exceeded expected time",
          now: nowIso,
        });
      }
    }

    // 4. Failed delivery
    if (st === "failed_delivery") {
      createExceptionCase(state, {
        category: "failed_delivery",
        severity: "critical",
        orderId: o.id,
        restaurantId: o.restaurantId,
        driverId: o.driverId,
        customerId: o.customerId,
        title: `Order ${o.id} delivery failed`,
        description: o.failedDeliveryReason || "Driver reported failed delivery",
        now: nowIso,
      });
    }
  }
  return state.cases;
}

/* ------------------------------------------------------------------ *
 * Section 16 — Rating Moderation & Complaint Escalation
 * ------------------------------------------------------------------ */

/**
 * Compute public rating summary for a store or driver.
 * - Numerical star ratings (1..5) are always included in the average.
 * - Written comments are ONLY included in public reviews when `moderationStatus === "approved"`.
 */
function computePublicRatingsSummary(orders = [], { targetType = "store", targetId }) {
  const tid = String(targetId || "");
  let sum = 0;
  let count = 0;
  const approvedReviews = [];

  for (const o of orders) {
    if (!o) continue;
    if (targetType === "store") {
      if (String(o.restaurantId || "") !== tid) continue;
      const r = o.customerRating || o.rating;
      if (!r || !Number.isFinite(Number(r.stars))) continue;
      const stars = Number(r.stars);
      if (stars < 1 || stars > 5) continue;
      sum += stars;
      count += 1;
      if (r.comment && r.moderationStatus === "approved") {
        approvedReviews.push({
          orderId: o.id,
          stars,
          comment: String(r.comment),
          createdAt: r.createdAt || o.deliveredAt || o.createdAt,
        });
      }
    } else if (targetType === "driver") {
      const r = o.driverRating;
      if (!r || String(r.driverId || o.driverId || "") !== tid) continue;
      const stars = Number(r.stars);
      if (!Number.isFinite(stars) || stars < 1 || stars > 5) continue;
      sum += stars;
      count += 1;
      if (r.comment && r.moderationStatus === "approved") {
        approvedReviews.push({
          orderId: o.id,
          stars,
          comment: String(r.comment),
          createdAt: r.createdAt || o.deliveredAt || o.createdAt,
        });
      }
    }
  }

  return {
    targetType,
    targetId: tid,
    count,
    averageStars: count > 0 ? Math.round((sum / count) * 100) / 100 : null,
    reviews: approvedReviews.slice(0, 50),
  };
}

/**
 * Create a customer complaint routed to the business/driver first, with escalation to supervisor.
 */
function createComplaint(
  state,
  {
    orderId,
    customerId,
    restaurantId = null,
    driverId = null,
    targetType = "store", // "store" | "driver" | "platform"
    category = "quality",
    description = "",
    now = new Date().toISOString(),
  }
) {
  ensureExceptionsState(state);
  const cleanDesc = String(description || "").trim();
  if (cleanDesc.length < 5) {
    return { ok: false, status: 400, error: "complaint_description_too_short" };
  }
  const target = ["store", "driver", "platform"].includes(targetType) ? targetType : "store";
  const stage = target === "platform" ? "supervisor_escalated" : "target_review";

  const complaint = {
    id: "CMP-" + crypto.randomBytes(5).toString("hex").toUpperCase(),
    orderId: orderId ? String(orderId) : null,
    customerId: String(customerId || ""),
    restaurantId: restaurantId ? String(restaurantId) : null,
    driverId: driverId ? String(driverId) : null,
    targetType: target,
    category: String(category || "general").slice(0, 60),
    description: cleanDesc.slice(0, 800),
    stage, // "target_review" -> "supervisor_escalated" -> "resolved"
    status: "open",
    targetResponse: null,
    supervisorResolution: null,
    createdAt: now,
    updatedAt: now,
  };
  state.complaints.unshift(complaint);

  if (stage === "supervisor_escalated") {
    createExceptionCase(state, {
      category: "complaint_dispute",
      severity: "high",
      orderId: complaint.orderId,
      restaurantId: complaint.restaurantId,
      driverId: complaint.driverId,
      customerId: complaint.customerId,
      title: `Customer complaint ${complaint.id}`,
      description: complaint.description,
      meta: { complaintId: complaint.id },
      now,
    });
  }

  return { ok: true, complaint };
}

function escalateComplaintToSupervisor(state, { complaintId, reason = "", actorType = "customer", now = new Date().toISOString() }) {
  ensureExceptionsState(state);
  const c = state.complaints.find((x) => x.id === String(complaintId));
  if (!c) return { ok: false, status: 404, error: "complaint_not_found" };
  c.stage = "supervisor_escalated";
  c.escalatedAt = now;
  c.escalationReason = String(reason || "Escalated to supervisor").slice(0, 300);
  c.escalatedBy = actorType;
  c.updatedAt = now;

  createExceptionCase(state, {
    category: "complaint_dispute",
    severity: "high",
    orderId: c.orderId,
    restaurantId: c.restaurantId,
    driverId: c.driverId,
    customerId: c.customerId,
    title: `Escalated complaint ${c.id}`,
    description: `${c.description} — Escalation: ${c.escalationReason}`,
    meta: { complaintId: c.id },
    now,
  });

  return { ok: true, complaint: c };
}

/* ------------------------------------------------------------------ *
 * Section 17 — Reports & Data Export (CSV, Excel .xlsx XML, PDF)
 * ------------------------------------------------------------------ */

function bucketPeriodKey(isoDate, period = "daily") {
  const d = new Date(isoDate || Date.now());
  if (Number.isNaN(d.getTime())) return "unknown";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  if (period === "monthly") return `${yyyy}-${mm}`;
  if (period === "weekly") {
    const firstJan = new Date(Date.UTC(yyyy, 0, 1));
    const week = Math.ceil(((d - firstJan) / 86400000 + firstJan.getUTCDay() + 1) / 7);
    return `${yyyy}-W${String(week).padStart(2, "0")}`;
  }
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Build a comprehensive financial & operational report scoped by role/tenant.
 */
function buildReport({
  orders = [],
  settlements = [],
  from = null,
  to = null,
  period = "daily", // "daily" | "weekly" | "monthly"
  storeId = null,   // enforced for store/restaurant role
  driverId = null,  // enforced for driver role
}) {
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;

  const filtered = orders.filter((o) => {
    if (!o) return false;
    if (storeId && String(o.restaurantId || "") !== String(storeId)) return false;
    if (driverId && String(o.driverId || "") !== String(driverId)) return false;
    const t = Date.parse(o.createdAt || o.deliveredAt || "");
    if (Number.isFinite(fromMs) && Number.isFinite(t) && t < fromMs) return false;
    if (Number.isFinite(toMs) && Number.isFinite(t) && t > toMs) return false;
    return true;
  });

  const summary = {
    totalOrders: filtered.length,
    deliveredOrders: 0,
    canceledOrders: 0,
    rejectedOrders: 0,
    failedDeliveryOrders: 0,
    grossSales: 0,
    totalDiscounts: 0,
    totalDeliveryFees: 0,
    totalPlatformCommissions: 0,
    totalNetMerchantPayable: 0,
    totalDriverEarnings: 0,
    byPaymentMethod: {
      cod: { count: 0, amount: 0 },
      wallet: { count: 0, amount: 0 },
      electronic: { count: 0, amount: 0 },
      split: { count: 0, amount: 0 },
    },
  };

  const buckets = {};
  const orderBreakdown = [];

  for (const o of filtered) {
    const st = String(o.status || "").toLowerCase();
    const isDelivered = st === "delivered" || st === "done";
    const isRejected = st === "rejected" || o.canceledBy === "store";
    const isCanceled = st === "canceled";
    const isFailed = st === "failed_delivery";

    if (isRejected) summary.rejectedOrders += 1;
    else if (isCanceled) summary.canceledOrders += 1;
    if (isFailed) summary.failedDeliveryOrders += 1;

    const snap = o.financialSnapshot || {};
    const subtotal = roundMoney(snap.grossSubtotal ?? o.subtotal ?? o.total ?? 0);
    const discount = roundMoney(snap.totalDiscount ?? o.discountAmount ?? 0);
    const deliveryFee = roundMoney(snap.netDeliveryFee ?? o.deliveryFee ?? 0);
    const total = roundMoney(snap.finalTotal ?? o.total ?? subtotal + deliveryFee - discount);
    const commission = roundMoney(snap.platformCommission ?? 0);
    const netMerchant = roundMoney(snap.netMerchantPayable ?? Math.max(0, subtotal - commission));
    const driverEarnings = roundMoney(o.driverEarningsSnapshot?.totalEarnings ?? snap.driverPayable ?? deliveryFee);
    const pm = String(o.paymentMethod || "cod").toLowerCase();

    if (isDelivered) {
      summary.deliveredOrders += 1;
      summary.grossSales = roundMoney(summary.grossSales + total);
      summary.totalDiscounts = roundMoney(summary.totalDiscounts + discount);
      summary.totalDeliveryFees = roundMoney(summary.totalDeliveryFees + deliveryFee);
      summary.totalPlatformCommissions = roundMoney(summary.totalPlatformCommissions + commission);
      summary.totalNetMerchantPayable = roundMoney(summary.totalNetMerchantPayable + netMerchant);
      summary.totalDriverEarnings = roundMoney(summary.totalDriverEarnings + driverEarnings);

      const pmBucket = pm.includes("+") ? "split" : pm === "wallet" ? "wallet" : ["card", "electronic", "online"].includes(pm) ? "electronic" : "cod";
      summary.byPaymentMethod[pmBucket].count += 1;
      summary.byPaymentMethod[pmBucket].amount = roundMoney(summary.byPaymentMethod[pmBucket].amount + total);

      const bKey = bucketPeriodKey(o.deliveredAt || o.createdAt, period);
      if (!buckets[bKey]) {
        buckets[bKey] = {
          period: bKey,
          deliveredOrders: 0,
          grossSales: 0,
          commissions: 0,
          netMerchant: 0,
          driverEarnings: 0,
        };
      }
      buckets[bKey].deliveredOrders += 1;
      buckets[bKey].grossSales = roundMoney(buckets[bKey].grossSales + total);
      buckets[bKey].commissions = roundMoney(buckets[bKey].commissions + commission);
      buckets[bKey].netMerchant = roundMoney(buckets[bKey].netMerchant + netMerchant);
      buckets[bKey].driverEarnings = roundMoney(buckets[bKey].driverEarnings + driverEarnings);
    }

    orderBreakdown.push({
      orderId: o.id,
      createdAt: o.createdAt || null,
      deliveredAt: o.deliveredAt || null,
      status: o.status,
      restaurantId: o.restaurantId || null,
      driverId: driverId ? o.driverId : storeId ? undefined : o.driverId || null,
      paymentMethod: pm,
      subtotal,
      discount,
      deliveryFee,
      total,
      commission: driverId ? undefined : commission,
      netMerchantPayable: driverId ? undefined : netMerchant,
      driverEarnings: storeId ? undefined : driverEarnings,
      storeSettlementId: o.storeSettlementId || null,
      driverSettlementId: o.driverSettlementId || null,
    });
  }

  const scopedSettlements = (Array.isArray(settlements) ? settlements : []).filter((s) => {
    if (storeId && (s.targetType !== "store" || String(s.targetId) !== String(storeId))) return false;
    if (driverId && (s.targetType !== "driver" || String(s.targetId) !== String(driverId))) return false;
    return true;
  });

  return {
    period,
    from: from || null,
    to: to || null,
    scope: storeId ? { type: "store", id: storeId } : driverId ? { type: "driver", id: driverId } : { type: "platform" },
    summary,
    series: Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period)),
    settlements: scopedSettlements,
    orders: orderBreakdown,
  };
}

function exportReportToCsv(report) {
  const cols = [
    "orderId",
    "createdAt",
    "status",
    "restaurantId",
    "paymentMethod",
    "subtotal",
    "discount",
    "deliveryFee",
    "total",
    "commission",
    "netMerchantPayable",
    "driverEarnings",
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const row of report.orders || []) {
    lines.push(cols.map((c) => esc(row[c])).join(","));
  }
  return "\uFEFF" + lines.join("\n");
}

function exportReportToExcelXml(report) {
  const escXml = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const cols = [
    "Order ID",
    "Created At",
    "Status",
    "Store ID",
    "Payment Method",
    "Subtotal (MAD)",
    "Discount (MAD)",
    "Delivery Fee (MAD)",
    "Total (MAD)",
    "Commission (MAD)",
    "Net Merchant (MAD)",
    "Driver Earnings (MAD)",
  ];
  const keys = [
    "orderId",
    "createdAt",
    "status",
    "restaurantId",
    "paymentMethod",
    "subtotal",
    "discount",
    "deliveryFee",
    "total",
    "commission",
    "netMerchantPayable",
    "driverEarnings",
  ];
  const headerCells = cols.map((c) => `<Cell><Data ss:Type="String">${escXml(c)}</Data></Cell>`).join("");
  const dataRows = (report.orders || [])
    .map((r) => {
      const cells = keys
        .map((k) => {
          const val = r[k];
          const isNum = typeof val === "number" && Number.isFinite(val);
          return `<Cell><Data ss:Type="${isNum ? "Number" : "String"}">${escXml(val ?? "")}</Data></Cell>`;
        })
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="SIYMON Report">
  <Table>
   <Row>${headerCells}</Row>
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

/**
 * Generate a real, standards-compliant PDF 1.4 binary buffer containing the report summary
 * and per-order financial breakdown without requiring external native binaries.
 */
function exportReportToPdfBuffer(report) {
  const s = report.summary || {};
  const lines = [
    "SIYMON DELIVERY PLATFORM - FINANCIAL & OPERATIONAL REPORT",
    `Generated: ${new Date().toISOString()}   Scope: ${report.scope?.type || "platform"} ${report.scope?.id || ""}`,
    "-------------------------------------------------------------------------",
    `Total Orders: ${s.totalOrders || 0} | Delivered: ${s.deliveredOrders || 0} | Canceled: ${s.canceledOrders || 0} | Rejected: ${s.rejectedOrders || 0}`,
    `Gross Sales: ${s.grossSales || 0} MAD | Discounts: ${s.totalDiscounts || 0} MAD | Delivery Fees: ${s.totalDeliveryFees || 0} MAD`,
    `Platform Commissions: ${s.totalPlatformCommissions || 0} MAD | Net Merchant Payable: ${s.totalNetMerchantPayable || 0} MAD`,
    `Driver Earnings: ${s.totalDriverEarnings || 0} MAD`,
    "-------------------------------------------------------------------------",
    "Order ID | Status | Method | Subtotal | Fee | Total | Comm | NetStore",
  ];
  for (const o of (report.orders || []).slice(0, 35)) {
    lines.push(
      `${o.orderId} | ${o.status} | ${o.paymentMethod} | ${o.subtotal} | ${o.deliveryFee} | ${o.total} | ${o.commission ?? "-"} | ${o.netMerchantPayable ?? "-"}`
    );
  }

  const escPdf = (str) =>
    String(str || "")
      .replace(/[^\x20-\x7E]/g, "?")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  const contentLines = ["BT", "/F1 9 Tf", "40 790 Td", "13 TL"];
  for (const ln of lines) {
    contentLines.push(`(${escPdf(ln)}) Tj T*`);
  }
  contentLines.push("ET");
  const streamData = contentLines.join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamData, "utf8")} >>\nstream\n${streamData}\nendstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

module.exports = {
  EXCEPTION_CATEGORIES,
  ensureExceptionsState,
  createExceptionCase,
  resolveExceptionCase,
  syncAutomaticOrderExceptions,
  computePublicRatingsSummary,
  createComplaint,
  escalateComplaintToSupervisor,
  buildReport,
  exportReportToCsv,
  exportReportToExcelXml,
  exportReportToPdfBuffer,
};
