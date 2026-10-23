"use strict";
/**
 * SIYMON Platform Routes (Phases 2–8):
 * - Phone OTP & Account Recovery, Session Revocation, Granular Supervisor RBAC (Section 4)
 * - Customer Pre-Acceptance Order Edit, Live Customer Location Sharing (Sections 5, 8)
 * - Pickup & Delivery Verification Codes & Supervisor Override (Section 9)
 * - Road-Distance Delivery Pricing & Berrechid Service Zones (Sections 10, 18)
 * - SIYMON Customer Wallet Ledger, Split Payments, Webhooks, Commissions, Manual Settlements, Refunds (Section 11)
 * - Promotions, Coupons, First-Order Discounts, Loyalty Points & Referrals (Section 12)
 * - Unified Supervisor Exception Center, Comment Moderation, Complaint Escalation (Sections 14, 16)
 * - Role-Specific Financial/Operational Reports with CSV, Excel & PDF Export (Section 17)
 * - Verified Data Backups & Real System Health Monitoring (Sections 21, 22)
 */

const crypto = require("crypto");
const securityRbac = require("./security-rbac");
const orderLifecycle = require("./order-lifecycle");
const zonesPricing = require("./service-zones-pricing");
const financeWallet = require("./finance-wallet");
const excModReports = require("./exceptions-moderation-reports");
const backupLib = require("./backup");
const pickupLocations = require("./pickup-location");

function registerPlatformRoutes(app, deps) {
  const {
    requireAdmin,
    requireCustomer,
    requireDriver,
    requireApprovedDriver,
    readJson,
    writeJson,
    loadConfig,
    saveConfig,
    loadOrders,
    saveOrders,
    loadCustomers,
    saveCustomers,
    loadDrivers,
    saveDrivers,
    loadRestaurants,
    saveRestaurants,
    loadMenu,
    saveMenu,
    loadAdmins,
    saveAdmins,
    loadAuditLogs,
    appendAuditLog,
    hashPassword,
    verifyPassword,
    makeId,
    routeService,
    dispatchService,
    notifyCustomer,
    dataFiles,
  } = deps;

  const OTP_FILE = dataFiles.otpFile;
  const WALLET_FILE = dataFiles.walletFile;
  const PROMOS_FILE = dataFiles.promosFile;
  const EXCEPTIONS_FILE = dataFiles.exceptionsFile;
  const ZONES_FILE = dataFiles.zonesFile;

  const loadOtpState = () => readJson(OTP_FILE, { challenges: [], proofs: [], revokedUsers: {}, revokedTokens: [] });
  const saveOtpState = (s) => writeJson(OTP_FILE, s);

  const loadWalletState = () => financeWallet.ensureWalletState(readJson(WALLET_FILE, {}));
  const saveWalletState = (s) => writeJson(WALLET_FILE, financeWallet.ensureWalletState(s));

  const loadPromosState = () => {
    const s = readJson(PROMOS_FILE, { coupons: [] });
    s.coupons = Array.isArray(s.coupons) ? s.coupons : [];
    return s;
  };
  const savePromosState = (s) => writeJson(PROMOS_FILE, s);

  const loadExceptionsState = () => excModReports.ensureExceptionsState(readJson(EXCEPTIONS_FILE, {}));
  const saveExceptionsState = (s) => writeJson(EXCEPTIONS_FILE, excModReports.ensureExceptionsState(s));

  const loadZones = () => {
    const s = readJson(ZONES_FILE, { zones: [zonesPricing.DEFAULT_BERRECHID_ZONE] });
    if (!Array.isArray(s.zones) || s.zones.length === 0) {
      s.zones = [zonesPricing.DEFAULT_BERRECHID_ZONE];
    }
    return s;
  };
  const saveZones = (s) => writeJson(ZONES_FILE, s);

  /**
   * Middleware factory enforcing granular supervisor permissions (Section 4).
   */
  function requirePerm(permission) {
    return (req, res, next) => {
      requireAdmin(req, res, () => {
        if (!permission) return next();
        const adminsData = loadAdmins();
        const adminRec =
          (adminsData.admins || []).find((a) => String(a.id) === String(req.adminId)) ||
          (req.adminId === "legacy" ? { id: "legacy", role: "system_admin", isActive: true } : null);
        // If no admins exist or legacy token, allow system_admin
        if (!adminRec && (adminsData.admins || []).length === 0) return next();
        if (!securityRbac.hasSupervisorPermission(adminRec, permission)) {
          return res.status(403).json({
            error: "Forbidden: insufficient supervisor permission",
            requiredPermission: permission,
          });
        }
        req.adminRecord = adminRec;
        next();
      });
    };
  }

  function logSensitive(req, { action, targetType, targetId, previousValue, newValue, reason }) {
    try {
      if (typeof appendAuditLog === "function") {
        appendAuditLog({
          actorType: req.adminId ? "admin" : req.driverId ? "driver" : req.customerId ? "customer" : "system",
          actorId: req.adminId || req.driverId || req.customerId || null,
          action,
          targetType,
          targetId,
          previousValue,
          newValue,
          reason: reason || null,
          ip: req.ip || "",
        });
      }
    } catch (_e) {}
  }

  /* ================================================================== *
   * 1. Phone SMS OTP Verification, Recovery & Session Revocation (Sec 4)
   * ================================================================== */

  app.post("/api/auth/otp/send", async (req, res) => {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const purpose = String(req.body?.purpose || "verify_phone").slice(0, 40);
    const otpState = loadOtpState();
    const ch = securityRbac.createOtpChallenge(otpState, {
      phone,
      purpose,
      ip: req.ip || "",
      secret: process.env.JWT_SECRET || "siymon-otp",
    });
    if (!ch.ok) {
      return res.status(ch.status || 400).json({ error: ch.error, retryAfterSec: ch.retryAfterSec });
    }
    saveOtpState(otpState);

    // Send SMS via external provider if configured; never log plaintext OTP!
    let deliveryMode = "sandbox_pending_provider";
    if (process.env.SMS_API_URL && process.env.SMS_API_KEY) {
      try {
        const resp = await fetch(process.env.SMS_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.SMS_API_KEY}`,
          },
          body: JSON.stringify({
            to: ch.phone,
            sender: process.env.SMS_SENDER_ID || "SIYMON",
            message: `SIYMON verification code: ${ch.code}`,
          }),
        });
        deliveryMode = resp.ok ? "sms_sent" : "sms_provider_error";
      } catch (_e) {
        deliveryMode = "sms_provider_unreachable";
      }
    }

    const payload = {
      ok: true,
      challengeId: ch.challengeId,
      phone: ch.phone,
      purpose: ch.purpose,
      expiresAt: ch.expiresAt,
      deliveryMode,
    };
    // Only return test preview code in non-production test/dev when explicitly enabled
    if (process.env.NODE_ENV !== "production" && req.body?.devPreview === true) {
      payload.devCode = ch.code;
    }
    res.json(payload);
  });

  app.post("/api/auth/otp/verify", (req, res) => {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const purpose = String(req.body?.purpose || "verify_phone").slice(0, 40);
    const code = String(req.body?.code || "").trim();
    const otpState = loadOtpState();
    const r = securityRbac.verifyOtpChallenge(otpState, {
      phone,
      purpose,
      code,
      secret: process.env.JWT_SECRET || "siymon-otp",
    });
    saveOtpState(otpState);
    if (!r.ok) {
      return res.status(r.status || 400).json({
        error: r.error,
        remainingAttempts: r.remainingAttempts,
      });
    }

    // If a customer with this phone exists, mark phoneVerified = true
    const custData = loadCustomers();
    const cust = (custData.customers || []).find(
      (c) => String(c.phone || "").replace(/\D/g, "") === r.phone
    );
    if (cust) {
      cust.phoneVerified = true;
      cust.phoneVerifiedAt = new Date().toISOString();
      saveCustomers(custData);
    }

    res.json({
      ok: true,
      verified: true,
      phone: r.phone,
      purpose: r.purpose,
      verificationToken: r.verificationToken,
    });
  });

  app.post("/api/auth/recover-password", (req, res) => {
    const accountType = String(req.body?.accountType || "customer").toLowerCase();
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const verificationToken = String(req.body?.verificationToken || "").trim();
    const newPassword = String(req.body?.newPassword || "");

    if (!phone || phone.length < 8) return res.status(400).json({ error: "Invalid phone" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password too short (min 6)" });

    const otpState = loadOtpState();
    const proof = securityRbac.consumeVerificationProof(otpState, {
      verificationToken,
      phone,
      purpose: "recover",
    });
    if (!proof.ok) {
      return res.status(401).json({ error: proof.error });
    }

    if (accountType === "driver") {
      const drvData = loadDrivers();
      const drv = (drvData.drivers || []).find((d) => String(d.phone || "").replace(/\D/g, "") === phone);
      if (!drv) return res.status(404).json({ error: "Account not found" });
      drv.password = hashPassword(newPassword);
      drv.updatedAt = new Date().toISOString();
      saveDrivers(drvData);
      securityRbac.revokeUserSessions(otpState, { userType: "driver", userId: drv.id, reason: "password_recovered" });
      saveOtpState(otpState);
      return res.json({ ok: true, recovered: true, accountType: "driver" });
    }

    const custData = loadCustomers();
    const cust = (custData.customers || []).find((c) => String(c.phone || "").replace(/\D/g, "") === phone);
    if (!cust) return res.status(404).json({ error: "Account not found" });
    cust.password = hashPassword(newPassword);
    cust.phoneVerified = true;
    cust.updatedAt = new Date().toISOString();
    saveCustomers(custData);
    securityRbac.revokeUserSessions(otpState, { userType: "customer", userId: cust.id, reason: "password_recovered" });
    saveOtpState(otpState);
    res.json({ ok: true, recovered: true, accountType: "customer" });
  });

  app.post("/api/customer/logout-all", requireCustomer, (req, res) => {
    const otpState = loadOtpState();
    securityRbac.revokeUserSessions(otpState, { userType: "customer", userId: req.customerId, reason: "logout_all" });
    saveOtpState(otpState);
    res.json({ ok: true });
  });

  /* ================================================================== *
   * 2. Granular Supervisor Roles & Audit Integrity (Section 4)
   * ================================================================== */

  app.get("/api/admin/roles", requirePerm(), (_req, res) => {
    res.json({
      ok: true,
      roles: securityRbac.SUPERVISOR_ROLES,
      rolePermissions: securityRbac.ROLE_PERMISSIONS,
    });
  });

  app.get("/api/admin/supervisors", requirePerm("users.manage"), (_req, res) => {
    const data = loadAdmins();
    const list = (data.admins || []).map((a) => ({
      id: a.id,
      name: a.name || "",
      email: a.email || "",
      phone: a.phone || "",
      subRole: a.subRole || a.role || "system_admin",
      permissions: Array.isArray(a.permissions) ? a.permissions : [],
      isActive: a.isActive !== false,
      createdAt: a.createdAt || null,
    }));
    res.json({ ok: true, supervisors: list });
  });

  app.post("/api/admin/supervisors", requirePerm("users.manage"), (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const password = String(req.body?.password || "");
    const subRole = String(req.body?.subRole || "support_agent").toLowerCase();
    const name = String(req.body?.name || "").trim().slice(0, 80);

    if (!securityRbac.SUPERVISOR_ROLES.includes(subRole)) {
      return res.status(400).json({ error: "Invalid supervisor role", validRoles: securityRbac.SUPERVISOR_ROLES });
    }
    if (!email || !email.includes("@")) return res.status(400).json({ error: "Invalid email" });
    if (!phone || phone.length < 8) return res.status(400).json({ error: "Invalid phone" });
    if (password.length < 6) return res.status(400).json({ error: "Password too short (min 6)" });

    const data = loadAdmins();
    data.admins = Array.isArray(data.admins) ? data.admins : [];
    if (data.admins.some((a) => String(a.email || "").toLowerCase() === email)) {
      return res.status(409).json({ error: "Email already exists" });
    }
    const rec = {
      id: "ADM-" + makeId(),
      name,
      email,
      phone,
      subRole,
      permissions: Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : [],
      password: hashPassword(password),
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    data.admins.push(rec);
    saveAdmins(data);
    logSensitive(req, { action: "supervisor_created", targetType: "admin", targetId: rec.id, newValue: { email, subRole } });
    const { password: _pw, ...safe } = rec;
    res.json({ ok: true, supervisor: safe });
  });

  app.patch("/api/admin/supervisors/:id", requirePerm("users.manage"), (req, res) => {
    const data = loadAdmins();
    const idx = (data.admins || []).findIndex((a) => String(a.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: "Supervisor not found" });
    const cur = data.admins[idx];
    const prevRole = cur.subRole || "system_admin";

    if (req.body?.subRole !== undefined) {
      const sr = String(req.body.subRole).toLowerCase();
      if (!securityRbac.SUPERVISOR_ROLES.includes(sr)) {
        return res.status(400).json({ error: "Invalid supervisor role" });
      }
      cur.subRole = sr;
    }
    if (req.body?.isActive !== undefined) {
      cur.isActive = req.body.isActive !== false;
      if (!cur.isActive) {
        const otpState = loadOtpState();
        securityRbac.revokeUserSessions(otpState, { userType: "admin", userId: cur.id, reason: "supervisor_disabled" });
        saveOtpState(otpState);
      }
    }
    if (Array.isArray(req.body?.permissions)) {
      cur.permissions = req.body.permissions.map(String);
    }
    if (req.body?.name !== undefined) cur.name = String(req.body.name || "").slice(0, 80);
    cur.updatedAt = new Date().toISOString();
    data.admins[idx] = cur;
    saveAdmins(data);
    logSensitive(req, {
      action: "supervisor_updated",
      targetType: "admin",
      targetId: cur.id,
      previousValue: { subRole: prevRole },
      newValue: { subRole: cur.subRole, isActive: cur.isActive },
    });
    const { password: _pw, ...safe } = cur;
    res.json({ ok: true, supervisor: safe });
  });

  app.get("/api/admin/audit-logs/verify", requirePerm(), (_req, res) => {
    const logs = loadAuditLogs().logs || [];
    const check = securityRbac.verifyAuditChain(logs, process.env.JWT_SECRET || "siymon-audit-chain");
    res.json({ ok: true, integrity: check, totalLogs: logs.length });
  });

  /* ================================================================== *
   * 3. Driver Onboarding Review & Safe Suspension Handling (Section 4)
   * ================================================================== */

  app.post("/api/admin/drivers/:id/review", requirePerm("drivers.approve"), (req, res) => {
    const id = String(req.params.id);
    const status = String(req.body?.status || "").toLowerCase();
    const reason = String(req.body?.reason || "").trim();
    if (!["approved", "rejected", "suspended", "pending"].includes(status)) {
      return res.status(400).json({ error: "Invalid driver status" });
    }
    if (["rejected", "suspended"].includes(status) && reason.length < 3) {
      return res.status(400).json({ error: "Reason required for rejection or suspension" });
    }

    const drvData = loadDrivers();
    const idx = (drvData.drivers || []).findIndex((d) => String(d.id) === id);
    if (idx < 0) return res.status(404).json({ error: "Driver not found" });

    const d = drvData.drivers[idx];
    const prevStatus = d.status;
    const nowIso = new Date().toISOString();
    d.status = status;
    d.approvalStatus = status;
    d.isVerified = status === "approved";
    d.reviewedBy = String(req.adminId || "admin");
    d.reviewedAt = nowIso;
    d.reviewReason = reason || null;
    if (req.body?.vehicleType) d.vehicleType = String(req.body.vehicleType).slice(0, 40);
    if (req.body?.vehiclePlate !== undefined) d.vehiclePlate = String(req.body.vehiclePlate || "").slice(0, 40);
    if (req.body?.drivingLicenceNumber !== undefined) d.drivingLicenceNumber = String(req.body.drivingLicenceNumber || "").slice(0, 60);
    d.updatedAt = nowIso;
    if (status === "approved") d.approvedAt = nowIso;
    if (status === "rejected") d.rejectedAt = nowIso;
    if (status === "suspended") d.suspendedAt = nowIso;
    saveDrivers(drvData);

    // Safe active-order handling when a driver is suspended or rejected (Section 4)
    const activeOrdersHandled = [];
    if (status === "suspended" || status === "rejected") {
      const otpState = loadOtpState();
      securityRbac.revokeUserSessions(otpState, { userType: "driver", userId: id, reason: `driver_${status}` });
      saveOtpState(otpState);

      try {
        dispatchService.setStatus(id, "paused");
      } catch (_e) {}

      const ordersData = loadOrders();
      const activeOrders = (ordersData.orders || []).filter(
        (o) => String(o.driverId || "") === id && ["accepted", "picked_up", "on_the_way"].includes(String(o.status || ""))
      );
      const excState = loadExceptionsState();
      for (const ord of activeOrders) {
        const pickupDone = !!(ord.verification?.pickup?.verifiedAt) || ["picked_up", "on_the_way"].includes(String(ord.status));
        if (!pickupDone && dispatchService && typeof dispatchService.reassignOrder === "function") {
          const reRes = dispatchService.reassignOrder(ord.id, {
            reason: `driver_${status}:${reason}`,
            actor: `admin:${req.adminId}`,
          });
          activeOrdersHandled.push({ orderId: ord.id, action: "auto_reassigned", result: reRes });
        } else {
          excModReports.createExceptionCase(excState, {
            category: "driver_failure",
            severity: "critical",
            orderId: ord.id,
            restaurantId: ord.restaurantId,
            driverId: id,
            customerId: ord.customerId,
            title: `Driver ${id} suspended while delivering order ${ord.id}`,
            description: `Driver already picked up order ${ord.id}. Reason: ${reason}`,
            createdBy: `admin:${req.adminId}`,
          });
          activeOrdersHandled.push({ orderId: ord.id, action: "exception_created_for_in_transit_order" });
        }
      }
      saveExceptionsState(excState);
    }

    logSensitive(req, {
      action: `driver_${status}`,
      targetType: "driver",
      targetId: id,
      previousValue: { status: prevStatus },
      newValue: { status, reason },
      reason,
    });

    const { password: _pw, ...safeDrv } = d;
    res.json({ ok: true, driver: safeDrv, activeOrdersHandled });
  });

  /* ================================================================== *
   * 4. Customer Pre-Acceptance Edit, Live Location, Verification Codes
   * ================================================================== */

  // Customer edits order before store acceptance (Section 5)
  app.patch("/api/customer/orders/:id/edit", requireCustomer, (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const idx = (ordersData.orders || []).findIndex((o) => String(o.id) === id);
    if (idx < 0) return res.status(404).json({ error: "Order not found" });
    const order = ordersData.orders[idx];

    if (String(order.customerId || "") !== String(req.customerId)) {
      return res.status(403).json({ error: "Not your order" });
    }
    const editCheck = orderLifecycle.canCustomerEdit(order);
    if (!editCheck.ok) {
      return res.status(editCheck.status || 409).json({ error: editCheck.error, code: editCheck.code });
    }

    const nowIso = new Date().toISOString();
    if (req.body?.notes !== undefined && order.customer) {
      order.customer.notes = String(req.body.notes || "").slice(0, 500);
    }
    if (req.body?.instructions !== undefined && order.customer) {
      order.customer.instructions = String(req.body.instructions || "").slice(0, 300);
    }
    if (Array.isArray(req.body?.items) && req.body.items.length > 0) {
      const restaurants = loadRestaurants().restaurants || [];
      const store = restaurants.find((r) => String(r.id) === String(order.restaurantId));
      if (!store) return res.status(400).json({ error: "Store not found" });
      const menu = loadMenu();
      const byId = new Map(
        (menu.items || [])
          .filter((it) => String(it.restaurantId) === String(order.restaurantId))
          .map((it) => [String(it.id), it])
      );
      // Restore previous stock first before validating new items
      for (const oldIt of order.items || []) {
        const mIt = byId.get(String(oldIt.id));
        if (mIt && mIt.stock !== null && mIt.stock !== undefined) {
          mIt.stock = Number(mIt.stock) + Number(oldIt.qty || 0);
        }
      }
      const pricing = deps.catalogLib.computePricing({
        store,
        lines: req.body.items,
        byId,
        nameOf: (src) => (typeof src.name === "string" ? src.name : src.name?.ar || src.name?.fr || src.name?.en || src.id),
      });
      if (!pricing.ok) {
        return res.status(pricing.status || 400).json({ error: pricing.error });
      }
      deps.catalogLib.applyStock(menu, pricing.items);
      saveMenu(menu);
      order.items = pricing.items;
      order.subtotal = pricing.subtotal;
      order.total = financeWallet.roundMoney(order.subtotal + Number(order.deliveryFee || 0) - Number(order.discountAmount || 0));
    }

    order.editedAt = nowIso;
    order.updatedAt = nowIso;
    orderLifecycle.appendOrderEvent(order, {
      type: "customer_edited_order",
      fromStatus: order.status,
      toStatus: order.status,
      actorType: "customer",
      actorId: req.customerId,
      now: nowIso,
    });
    ordersData.orders[idx] = order;
    saveOrders(ordersData);
    res.json({ ok: true, order: orderLifecycle.sanitizeOrderVerificationForRole(order, "customer") });
  });

  // Optional live customer location sharing during active delivery (Section 8)
  app.post("/api/customer/orders/:id/live-location", requireCustomer, (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.customerId || "") !== String(req.customerId)) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (req.body?.stop === true) {
      order.customerLiveLocation = null;
      saveOrders(ordersData);
      return res.json({ ok: true, sharing: false });
    }
    if (!["accepted", "picked_up", "on_the_way"].includes(String(order.status || ""))) {
      return res.status(409).json({ error: "Live location sharing is only active during delivery" });
    }
    const pt = pickupLocations.normalizeCoords(req.body?.lat, req.body?.lng);
    if (!pt) return res.status(400).json({ error: "Invalid coordinates" });
    order.customerLiveLocation = {
      lat: pt.lat,
      lng: pt.lng,
      updatedAt: new Date().toISOString(),
    };
    saveOrders(ordersData);
    res.json({ ok: true, sharing: true, customerLiveLocation: order.customerLiveLocation });
  });

  app.get("/api/customer/orders/:id/verification", requireCustomer, (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.customerId || "") !== String(req.customerId)) {
      return res.status(403).json({ error: "Not your order" });
    }
    const sanitized = orderLifecycle.sanitizeOrderVerificationForRole(order, "customer");
    res.json({
      ok: true,
      orderId: order.id,
      deliveryCode: sanitized.deliveryCode || null,
      verificationStatus: sanitized.verificationStatus || null,
    });
  });

  // Driver verifies pickup code from business (Section 9)
  app.post("/api/driver/orders/:id/verify-pickup", requireDriver, requireApprovedDriver, (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const r = orderLifecycle.verifyStageCode(order, {
      stage: "pickup",
      code: req.body?.code,
      driverId: req.driverId,
    });
    if (!r.ok) {
      saveOrders(ordersData);
      if (r.error === "verification_max_attempts_exceeded") {
        const excState = loadExceptionsState();
        excModReports.createExceptionCase(excState, {
          category: "verification_override",
          severity: "high",
          orderId: order.id,
          restaurantId: order.restaurantId,
          driverId: req.driverId,
          title: `Pickup verification locked on order ${order.id}`,
          description: "Driver exceeded maximum pickup code verification attempts",
        });
        saveExceptionsState(excState);
      }
      return res.status(r.status || 400).json(r);
    }

    order.status = "picked_up";
    order.pickedUpAt = r.verifiedAt;
    order.updatedAt = r.verifiedAt;
    saveOrders(ordersData);

    try {
      notifyCustomer({
        customerId: order.customerId,
        orderId: order.id,
        type: "order_status",
        title: "تم استلام طلبك من المتجر",
        message: `المندوب استلم طلبك #${order.id} وهو في الطريق إليك`,
      });
    } catch (_e) {}

    res.json({
      ok: true,
      stage: "pickup",
      verifiedAt: r.verifiedAt,
      order: pickupLocations.orderForDriver(
        orderLifecycle.sanitizeOrderVerificationForRole(order, "driver"),
        req.driverId,
        loadRestaurants().restaurants || [],
        loadConfig().pickupLocation
      ),
    });
  });

  // Driver verifies delivery code from customer (Section 9)
  app.post("/api/driver/orders/:id/verify-delivery", requireDriver, requireApprovedDriver, (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const r = orderLifecycle.verifyStageCode(order, {
      stage: "delivery",
      code: req.body?.code,
      driverId: req.driverId,
    });
    if (!r.ok) {
      saveOrders(ordersData);
      if (r.error === "verification_max_attempts_exceeded") {
        const excState = loadExceptionsState();
        excModReports.createExceptionCase(excState, {
          category: "verification_override",
          severity: "high",
          orderId: order.id,
          restaurantId: order.restaurantId,
          driverId: req.driverId,
          customerId: order.customerId,
          title: `Delivery verification locked on order ${order.id}`,
          description: "Driver exceeded maximum delivery code verification attempts",
        });
        saveExceptionsState(excState);
      }
      return res.status(r.status || 400).json(r);
    }

    order.status = "delivered";
    order.deliveredAt = r.verifiedAt;
    order.updatedAt = r.verifiedAt;
    order.customerLiveLocation = null; // End live customer location sharing immediately on completion!

    // Award customer loyalty points on delivery (Section 12)
    if (order.customerId) {
      const wState = loadWalletState();
      financeWallet.awardLoyaltyForDeliveredOrder(wState, { order, now: r.verifiedAt });
      saveWalletState(wState);
    }

    saveOrders(ordersData);

    try {
      notifyCustomer({
        customerId: order.customerId,
        orderId: order.id,
        type: "order_status",
        title: "تم توصيل طلبك بنجاح",
        message: `شكراً لاختيارك SIYMON! تم تسليم طلبك #${order.id}.`,
      });
    } catch (_e) {}

    res.json({
      ok: true,
      stage: "delivery",
      verifiedAt: r.verifiedAt,
      order: pickupLocations.orderForDriver(
        orderLifecycle.sanitizeOrderVerificationForRole(order, "driver"),
        req.driverId,
        loadRestaurants().restaurants || [],
        loadConfig().pickupLocation
      ),
    });
  });

  // Driver reports inability to complete delivery or failed delivery (Sections 7, 14)
  app.post("/api/driver/orders/:id/report-issue", requireDriver, requireApprovedDriver, (req, res) => {
    const id = String(req.params.id);
    const issueType = String(req.body?.issueType || "cannot_complete").toLowerCase();
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3) return res.status(400).json({ error: "Reason required" });

    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (String(order.driverId || "") !== String(req.driverId)) {
      return res.status(403).json({ error: "Not your order" });
    }

    const pickupDone = !!(order.verification?.pickup?.verifiedAt) || ["picked_up", "on_the_way"].includes(String(order.status));
    if (!pickupDone && issueType === "cannot_complete" && dispatchService && typeof dispatchService.reassignOrder === "function") {
      const reRes = dispatchService.reassignOrder(order.id, {
        reason: `driver_reported:${reason}`,
        actor: `driver:${req.driverId}`,
      });
      return res.json({ ok: true, action: "reassigned", result: reRes });
    }

    const nowIso = new Date().toISOString();
    order.status = "failed_delivery";
    order.failedDeliveryReason = reason;
    order.failedDeliveryAt = nowIso;
    order.updatedAt = nowIso;
    orderLifecycle.appendOrderEvent(order, {
      type: "failed_delivery_reported",
      fromStatus: "on_the_way",
      toStatus: "failed_delivery",
      actorType: "driver",
      actorId: req.driverId,
      reason,
      now: nowIso,
    });
    saveOrders(ordersData);

    const excState = loadExceptionsState();
    const exc = excModReports.createExceptionCase(excState, {
      category: "failed_delivery",
      severity: "critical",
      orderId: order.id,
      restaurantId: order.restaurantId,
      driverId: req.driverId,
      customerId: order.customerId,
      title: `Failed delivery on order ${order.id}`,
      description: reason,
      createdBy: `driver:${req.driverId}`,
      now: nowIso,
    });
    saveExceptionsState(excState);

    res.json({ ok: true, action: "exception_created", exceptionCase: exc.exceptionCase });
  });

  // Supervisor verification code exception override (Section 9)
  app.post("/api/admin/orders/:id/override-verification", requirePerm("orders.verify_override"), (req, res) => {
    const id = String(req.params.id);
    const stage = String(req.body?.stage || "").toLowerCase();
    const reason = String(req.body?.reason || "").trim();
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const r = orderLifecycle.supervisorOverrideVerification(order, {
      stage,
      supervisorId: req.adminId || "admin",
      reason,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);

    if (stage === "pickup" && order.status === "accepted") {
      order.status = "picked_up";
      order.pickedUpAt = r.verifiedAt;
    } else if (stage === "delivery" && ["picked_up", "on_the_way", "accepted"].includes(order.status)) {
      order.status = "delivered";
      order.deliveredAt = r.verifiedAt;
      order.customerLiveLocation = null;
    }
    order.updatedAt = r.verifiedAt;
    saveOrders(ordersData);

    logSensitive(req, {
      action: `override_${stage}_verification`,
      targetType: "order",
      targetId: order.id,
      newValue: { stage, verifiedAt: r.verifiedAt },
      reason,
    });

    res.json({ ok: true, stage, verifiedAt: r.verifiedAt, order });
  });

  /* ================================================================== *
   * 5. Road-Distance Pricing Estimate & Service Zones (Sections 10, 18)
   * ================================================================== */

  app.get("/api/service-zones", (_req, res) => {
    const zData = loadZones();
    res.json({ ok: true, zones: zonesPricing.getActiveZones(zData.zones) });
  });

  app.get("/api/admin/service-zones", requirePerm("zones.read"), (_req, res) => {
    res.json({ ok: true, zones: loadZones().zones });
  });

  app.post("/api/admin/service-zones", requirePerm("orders.write"), (req, res) => {
    const b = req.body || {};
    const center = pickupLocations.normalizeCoords(b.center?.lat ?? b.lat, b.center?.lng ?? b.lng);
    if (!center && (!Array.isArray(b.polygon) || b.polygon.length < 3)) {
      return res.status(400).json({ error: "Valid center coordinates or polygon required" });
    }
    const zData = loadZones();
    const zone = {
      id: b.id ? String(b.id) : "zone-" + makeId(),
      name: typeof b.name === "object" ? b.name : { ar: String(b.name || "برشيد"), fr: String(b.name || "Berrechid"), en: String(b.name || "Berrechid") },
      city: String(b.city || "Berrechid"),
      isActive: b.isActive !== false,
      type: Array.isArray(b.polygon) && b.polygon.length >= 3 ? "polygon" : "radius",
      center: center || { lat: 33.2655, lng: -7.5875 },
      radiusKm: Math.max(0.5, Number(b.radiusKm || 12)),
      maxRoadDistanceKm: Math.max(1, Number(b.maxRoadDistanceKm || 20)),
      polygon: Array.isArray(b.polygon) ? b.polygon : null,
      pricing: {
        pricePerKm: Math.max(0, Number(b.pricing?.pricePerKm ?? b.pricePerKm ?? 3.0)),
        baseFee: Math.max(0, Number(b.pricing?.baseFee ?? b.baseFee ?? 0)),
        minDeliveryFee: Math.max(0, Number(b.pricing?.minDeliveryFee ?? 0)),
        maxDeliveryFee: Math.max(0, Number(b.pricing?.maxDeliveryFee ?? 150)),
      },
      driverEarnings: {
        basePay: Math.max(0, Number(b.driverEarnings?.basePay ?? 5.0)),
        distanceRatePerKm: Math.max(0, Number(b.driverEarnings?.distanceRatePerKm ?? 2.0)),
      },
    };
    zData.zones.push(zone);
    saveZones(zData);
    logSensitive(req, { action: "service_zone_created", targetType: "zone", targetId: zone.id, newValue: zone });
    res.json({ ok: true, zone });
  });

  app.put("/api/admin/service-zones/:id", requirePerm("orders.write"), (req, res) => {
    const zData = loadZones();
    const idx = zData.zones.findIndex((z) => String(z.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: "Zone not found" });
    const cur = zData.zones[idx];
    const b = req.body || {};
    if (b.isActive !== undefined) cur.isActive = b.isActive !== false;
    if (b.radiusKm !== undefined) cur.radiusKm = Math.max(0.5, Number(b.radiusKm));
    if (b.maxRoadDistanceKm !== undefined) cur.maxRoadDistanceKm = Math.max(1, Number(b.maxRoadDistanceKm));
    if (b.pricing && typeof b.pricing === "object") {
      cur.pricing = { ...cur.pricing, ...b.pricing };
    }
    if (b.driverEarnings && typeof b.driverEarnings === "object") {
      cur.driverEarnings = { ...cur.driverEarnings, ...b.driverEarnings };
    }
    zData.zones[idx] = cur;
    saveZones(zData);
    logSensitive(req, { action: "service_zone_updated", targetType: "zone", targetId: cur.id, newValue: cur });
    res.json({ ok: true, zone: cur });
  });

  // Estimate delivery fee from road distance before checkout confirmation (Section 10)
  app.post("/api/delivery/estimate", async (req, res) => {
    const restaurantId = String(req.body?.restaurantId || req.body?.storeId || "").trim();
    const dropoff = pickupLocations.normalizeCoords(
      req.body?.lat ?? req.body?.dropoff?.lat ?? req.body?.delivery?.lat,
      req.body?.lng ?? req.body?.dropoff?.lng ?? req.body?.delivery?.lng
    );
    if (!dropoff) return res.status(400).json({ error: "delivery_coordinates_missing" });

    const restaurants = loadRestaurants().restaurants || [];
    const store = restaurants.find((r) => String(r.id) === restaurantId) || restaurants[0];
    const cfg = loadConfig();
    const pickup = pickupLocations.resolvePickup({ restaurantId: store?.id }, restaurants, cfg.pickupLocation);
    if (!pickup) {
      return res.status(422).json({ error: "pickup_coordinates_missing" });
    }

    const calc = await zonesPricing.calculateRoadDeliveryPricing({
      pickup,
      dropoff,
      routeService,
      zones: loadZones().zones,
      pricingOverride: cfg.deliveryPricing || null,
    });
    if (!calc.ok) {
      return res.status(calc.status || 422).json(calc);
    }
    res.json(calc);
  });

  /* ================================================================== *
   * 6. Customer Wallet, Webhooks, Promotions, Settlements, Refunds
   * ================================================================== */

  app.get("/api/customer/wallet", requireCustomer, (req, res) => {
    const wState = loadWalletState();
    const cid = String(req.customerId);
    const balance = financeWallet.getCustomerWalletBalance(wState, cid);
    const entries = (wState.entries || []).filter((e) => e.customerId === cid).slice(0, 100);
    const loyalty = wState.loyalty[cid] || { points: 0, totalEarned: 0, totalRedeemed: 0, history: [] };
    if (!wState.referrals[cid]) {
      wState.referrals[cid] = {
        code: "SYM-" + cid.slice(-5).toUpperCase(),
        referredCount: 0,
      };
      saveWalletState(wState);
    }
    res.json({
      ok: true,
      currency: "MAD",
      balance,
      entries,
      loyalty,
      referral: wState.referrals[cid],
    });
  });

  app.post("/api/customer/loyalty/redeem", requireCustomer, (req, res) => {
    const wState = loadWalletState();
    const r = financeWallet.redeemLoyaltyPointsToWallet(wState, {
      customerId: req.customerId,
      points: req.body?.points,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveWalletState(wState);
    res.json(r);
  });

  app.post("/api/admin/wallets/:customerId/adjust", requirePerm("wallets.adjust"), (req, res) => {
    const customerId = String(req.params.customerId);
    const direction = String(req.body?.direction || "credit").toLowerCase();
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || "").trim();
    const idempotencyKey = req.body?.idempotencyKey || null;

    const wState = loadWalletState();
    const r = financeWallet.recordWalletTransaction(wState, {
      customerId,
      type: "admin_adjustment",
      direction,
      amount,
      idempotencyKey,
      actorType: "admin",
      actorId: req.adminId || "admin",
      reason,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveWalletState(wState);
    logSensitive(req, {
      action: "customer_wallet_adjusted",
      targetType: "customer_wallet",
      targetId: customerId,
      newValue: { direction, amount, balanceAfter: r.balance },
      reason,
    });
    res.json(r);
  });

  // Electronic payment webhook verification (Section 11)
  app.post("/api/payments/webhook", (req, res) => {
    const wState = loadWalletState();
    const secret = process.env.PAYMENT_WEBHOOK_SECRET || loadConfig().paymentWebhookSecret || "";
    const r = financeWallet.verifyElectronicPaymentWebhook(wState, {
      intentId: req.body?.intentId,
      orderId: req.body?.orderId,
      status: req.body?.status,
      providerReference: req.body?.providerReference,
      signature: req.headers["x-siymon-signature"] || req.body?.signature,
      rawPayload: req.body?.rawPayload,
      webhookSecret: secret,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveWalletState(wState);

    if (r.intent && r.intent.status === "succeeded" && r.intent.orderId) {
      const ordersData = loadOrders();
      const ord = (ordersData.orders || []).find((o) => String(o.id) === String(r.intent.orderId));
      if (ord) {
        ord.paymentStatus = "paid";
        ord.paidAt = r.intent.verifiedAt;
        saveOrders(ordersData);
      }
    }
    res.json(r);
  });

  // Promotions & Coupons (Section 12)
  app.get("/api/admin/promotions", requirePerm("finance.read"), (_req, res) => {
    res.json({ ok: true, coupons: loadPromosState().coupons, firstOrderPromo: loadConfig().firstOrderPromo || null });
  });

  app.post("/api/admin/promotions", requirePerm("finance.write"), (req, res) => {
    const b = req.body || {};
    const code = String(b.code || "").trim().toUpperCase();
    if (!code || code.length < 3 || code.length > 30) {
      return res.status(400).json({ error: "Invalid coupon code" });
    }
    const pState = loadPromosState();
    if (pState.coupons.some((c) => String(c.code).toUpperCase() === code)) {
      return res.status(409).json({ error: "Coupon code already exists" });
    }
    const coupon = {
      id: "PRM-" + makeId(),
      code,
      discountType: ["percent", "fixed", "free_delivery"].includes(b.discountType) ? b.discountType : "percent",
      value: Math.max(0, Number(b.value || 10)),
      minOrder: Math.max(0, Number(b.minOrder || 0)),
      maxDiscount: b.maxDiscount ? Math.max(0, Number(b.maxDiscount)) : null,
      storeId: b.storeId ? String(b.storeId) : null,
      startsAt: b.startsAt || null,
      endsAt: b.endsAt || null,
      maxUses: b.maxUses ? Math.max(1, Number(b.maxUses)) : null,
      maxUsesPerCustomer: b.maxUsesPerCustomer ? Math.max(1, Number(b.maxUsesPerCustomer)) : 1,
      firstOrderOnly: b.firstOrderOnly === true,
      costBearer: ["platform", "store", "split"].includes(b.costBearer) ? b.costBearer : "platform",
      storeSplitPct: Number(b.storeSplitPct ?? 50),
      usedCount: 0,
      usedBy: {},
      isActive: b.isActive !== false,
      createdAt: new Date().toISOString(),
    };
    pState.coupons.unshift(coupon);
    savePromosState(pState);
    logSensitive(req, { action: "promotion_created", targetType: "promotion", targetId: coupon.code, newValue: coupon });
    res.json({ ok: true, coupon });
  });

  app.delete("/api/admin/promotions/:code", requirePerm("finance.write"), (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const pState = loadPromosState();
    const before = pState.coupons.length;
    pState.coupons = pState.coupons.filter((c) => String(c.code).toUpperCase() !== code);
    if (pState.coupons.length === before) return res.status(404).json({ error: "Coupon not found" });
    savePromosState(pState);
    res.json({ ok: true });
  });

  app.post("/api/promotions/validate", (req, res) => {
    const customerId = req.body?.customerId || null;
    const priorOrders = customerId
      ? (loadOrders().orders || []).filter((o) => String(o.customerId) === String(customerId) && o.status !== "canceled").length
      : 0;
    const r = financeWallet.evaluatePromotion({
      couponCode: req.body?.couponCode,
      coupons: loadPromosState().coupons,
      subtotal: Number(req.body?.subtotal || 0),
      deliveryFee: Number(req.body?.deliveryFee || 0),
      storeId: req.body?.restaurantId || null,
      customerId,
      customerPriorOrdersCount: priorOrders,
      firstOrderPromo: loadConfig().firstOrderPromo || null,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    res.json(r);
  });

  // Manual Settlements (Section 11)
  app.get("/api/admin/settlements", requirePerm("settlements.read"), (_req, res) => {
    res.json({ ok: true, settlements: loadWalletState().settlements || [] });
  });

  app.post("/api/admin/settlements", requirePerm("settlements.write"), (req, res) => {
    const wState = loadWalletState();
    const ordersData = loadOrders();
    const r = financeWallet.createManualSettlement(wState, {
      targetType: req.body?.targetType || "store",
      targetId: req.body?.targetId,
      orders: ordersData.orders || [],
      method: req.body?.method || "cash",
      reference: req.body?.reference || "",
      note: req.body?.note || "",
      actorId: req.adminId || "admin",
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveOrders(ordersData);
    saveWalletState(wState);
    logSensitive(req, {
      action: "manual_settlement_recorded",
      targetType: r.settlement.targetType,
      targetId: r.settlement.targetId,
      newValue: r.settlement,
    });
    res.json(r);
  });

  // Authorized Refunds (Section 11)
  app.post("/api/admin/orders/:id/refund", requirePerm("refunds.approve"), (req, res) => {
    const id = String(req.params.id);
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const wState = loadWalletState();
    const r = financeWallet.processAuthorizedRefund(wState, {
      order,
      amount: req.body?.amount,
      destination: req.body?.destination || "wallet",
      reason: req.body?.reason,
      actorId: req.adminId || "admin",
      actorRole: "admin",
    });
    if (!r.ok) return res.status(r.status || 400).json(r);

    orderLifecycle.appendOrderEvent(order, {
      type: "refund_processed",
      fromStatus: order.status,
      toStatus: order.status,
      actorType: "admin",
      actorId: req.adminId || "admin",
      reason: req.body?.reason,
      meta: { refundId: r.refund.id, amount: r.refund.amount, destination: r.refund.destination },
    });
    saveOrders(ordersData);
    saveWalletState(wState);

    logSensitive(req, {
      action: "order_refunded",
      targetType: "order",
      targetId: order.id,
      newValue: r.refund,
      reason: req.body?.reason,
    });

    res.json(r);
  });

  /* ================================================================== *
   * 7. Unified Supervisor Exception Center, Moderation & Complaints
   * ================================================================== */

  app.get("/api/admin/exceptions", requirePerm("exceptions.read"), (req, res) => {
    const excState = loadExceptionsState();
    excModReports.syncAutomaticOrderExceptions(excState, loadOrders().orders || []);
    saveExceptionsState(excState);
    const statusFilter = String(req.query.status || "").toLowerCase();
    const catFilter = String(req.query.category || "").toLowerCase();
    const list = (excState.cases || []).filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (catFilter && c.category !== catFilter) return false;
      return true;
    });
    res.json({ ok: true, total: list.length, cases: list, categories: excModReports.EXCEPTION_CATEGORIES });
  });

  app.post("/api/admin/exceptions/:id/resolve", requirePerm("exceptions.write"), (req, res) => {
    const excState = loadExceptionsState();
    const c = (excState.cases || []).find((x) => x.id === String(req.params.id));
    if (!c) return res.status(404).json({ error: "Exception case not found" });

    const decision = String(req.body?.decision || "resolved");
    const notes = String(req.body?.notes || "").trim();
    let redeliveryOrderId = null;

    // Optional action execution (e.g. schedule redelivery or reassign driver)
    if (decision === "reassigned" && c.orderId && dispatchService?.reassignOrder) {
      dispatchService.reassignOrder(c.orderId, {
        reason: `exception_resolved:${notes}`,
        actor: `admin:${req.adminId}`,
        allowAfterPickup: true,
      });
    } else if (decision === "redelivery_scheduled" && c.orderId) {
      const ordersData = loadOrders();
      const orig = (ordersData.orders || []).find((o) => String(o.id) === String(c.orderId));
      if (orig) {
        orig.status = "restaurant_ready";
        orig.driverId = null;
        orig.redeliveryScheduledAt = new Date().toISOString();
        orderLifecycle.initOrderVerification(orig);
        saveOrders(ordersData);
        redeliveryOrderId = orig.id;
      }
    } else if (c.category === "rejected_order" && c.orderId) {
      const ordersData = loadOrders();
      const orig = (ordersData.orders || []).find((o) => String(o.id) === String(c.orderId));
      if (orig) {
        orig.rejectionReviewStatus = "reviewed";
        orig.rejectionReviewedBy = String(req.adminId || "admin");
        saveOrders(ordersData);
      }
    }

    const r = excModReports.resolveExceptionCase(excState, {
      caseId: c.id,
      supervisorId: req.adminId || "admin",
      decision,
      notes,
      redeliveryOrderId,
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveExceptionsState(excState);
    logSensitive(req, {
      action: "exception_resolved",
      targetType: "exception",
      targetId: c.id,
      newValue: r.exceptionCase.resolution,
      reason: notes,
    });
    res.json(r);
  });

  // Public Ratings with Comment Moderation (Section 16)
  app.get("/api/stores/:id/ratings", (req, res) => {
    const summary = excModReports.computePublicRatingsSummary(loadOrders().orders || [], {
      targetType: "store",
      targetId: req.params.id,
    });
    res.json({ ok: true, ...summary });
  });

  app.get("/api/admin/ratings/moderation", requirePerm("ratings.moderate"), (_req, res) => {
    const pending = [];
    for (const o of loadOrders().orders || []) {
      const sr = o.customerRating || o.rating;
      if (sr && sr.comment && (!sr.moderationStatus || sr.moderationStatus === "pending")) {
        pending.push({ orderId: o.id, targetType: "store", targetId: o.restaurantId, stars: sr.stars, comment: sr.comment, createdAt: sr.createdAt });
      }
      if (o.driverRating && o.driverRating.comment && (!o.driverRating.moderationStatus || o.driverRating.moderationStatus === "pending")) {
        pending.push({ orderId: o.id, targetType: "driver", targetId: o.driverId, stars: o.driverRating.stars, comment: o.driverRating.comment, createdAt: o.driverRating.createdAt });
      }
    }
    res.json({ ok: true, pending });
  });

  app.post("/api/admin/ratings/:orderId/moderate", requirePerm("ratings.moderate"), (req, res) => {
    const targetType = String(req.body?.targetType || "store").toLowerCase();
    const status = String(req.body?.status || "approved").toLowerCase();
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid moderation status" });
    }
    const ordersData = loadOrders();
    const order = (ordersData.orders || []).find((o) => String(o.id) === String(req.params.orderId));
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (targetType === "driver") {
      if (!order.driverRating) return res.status(404).json({ error: "Driver rating not found on order" });
      order.driverRating.moderationStatus = status;
      order.driverRating.moderatedBy = String(req.adminId || "admin");
      order.driverRating.moderatedAt = new Date().toISOString();
    } else {
      const sr = order.customerRating || order.rating;
      if (!sr) return res.status(404).json({ error: "Store rating not found on order" });
      sr.moderationStatus = status;
      sr.moderatedBy = String(req.adminId || "admin");
      sr.moderatedAt = new Date().toISOString();
      order.customerRating = sr;
      order.rating = sr;
    }
    saveOrders(ordersData);
    res.json({ ok: true, orderId: order.id, targetType, moderationStatus: status });
  });

  // Structured Customer Complaints & Escalation (Section 16)
  app.post("/api/customer/complaints", requireCustomer, (req, res) => {
    const excState = loadExceptionsState();
    const orders = loadOrders().orders || [];
    const ord = req.body?.orderId ? orders.find((o) => String(o.id) === String(req.body.orderId)) : null;
    if (ord && String(ord.customerId || "") !== String(req.customerId)) {
      return res.status(403).json({ error: "Not your order" });
    }
    const r = excModReports.createComplaint(excState, {
      orderId: ord ? ord.id : null,
      customerId: req.customerId,
      restaurantId: ord ? ord.restaurantId : req.body?.restaurantId || null,
      driverId: ord ? ord.driverId : req.body?.driverId || null,
      targetType: req.body?.targetType || "store",
      category: req.body?.category || "service",
      description: req.body?.description || "",
    });
    if (!r.ok) return res.status(r.status || 400).json(r);
    saveExceptionsState(excState);
    res.json(r);
  });

  app.get("/api/customer/complaints", requireCustomer, (req, res) => {
    const list = (loadExceptionsState().complaints || []).filter(
      (c) => String(c.customerId) === String(req.customerId)
    );
    res.json({ ok: true, complaints: list });
  });

  app.post("/api/customer/complaints/:id/escalate", requireCustomer, (req, res) => {
    const excState = loadExceptionsState();
    const c = (excState.complaints || []).find((x) => x.id === String(req.params.id));
    if (!c || String(c.customerId) !== String(req.customerId)) {
      return res.status(404).json({ error: "Complaint not found" });
    }
    const r = excModReports.escalateComplaintToSupervisor(excState, {
      complaintId: c.id,
      reason: req.body?.reason || "Customer requested supervisor escalation",
      actorType: "customer",
    });
    saveExceptionsState(excState);
    res.json(r);
  });

  app.get("/api/admin/complaints", requirePerm("complaints.read"), (_req, res) => {
    res.json({ ok: true, complaints: loadExceptionsState().complaints || [] });
  });

  /* ================================================================== *
   * 8. Role-Specific Reports & Exports (CSV, Excel, PDF) (Section 17)
   * ================================================================== */

  app.get("/api/admin/reports", requirePerm("reports.read"), (req, res) => {
    const report = excModReports.buildReport({
      orders: loadOrders().orders || [],
      settlements: loadWalletState().settlements || [],
      from: req.query.from || null,
      to: req.query.to || null,
      period: String(req.query.period || "daily"),
      storeId: req.query.storeId || null,
      driverId: req.query.driverId || null,
    });
    res.json({ ok: true, report });
  });

  app.get("/api/admin/reports/export", requirePerm("reports.read"), (req, res) => {
    const format = String(req.query.format || "csv").toLowerCase();
    const report = excModReports.buildReport({
      orders: loadOrders().orders || [],
      settlements: loadWalletState().settlements || [],
      from: req.query.from || null,
      to: req.query.to || null,
      period: String(req.query.period || "daily"),
      storeId: req.query.storeId || null,
      driverId: req.query.driverId || null,
    });
    if (format === "pdf") {
      const buf = excModReports.exportReportToPdfBuffer(report);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="siymon-report.pdf"');
      return res.send(buf);
    }
    if (format === "xlsx" || format === "excel" || format === "xls") {
      const xml = excModReports.exportReportToExcelXml(report);
      res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="siymon-report.xls"');
      return res.send(xml);
    }
    const csv = excModReports.exportReportToCsv(report);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="siymon-report.csv"');
    return res.send(csv);
  });

  app.get("/api/driver/reports", requireDriver, (req, res) => {
    const report = excModReports.buildReport({
      orders: loadOrders().orders || [],
      settlements: loadWalletState().settlements || [],
      from: req.query.from || null,
      to: req.query.to || null,
      period: String(req.query.period || "daily"),
      driverId: String(req.driverId),
    });
    res.json({ ok: true, report });
  });

  /* ================================================================== *
   * 9. System Health Monitoring & Verified Backups (Sections 21, 22)
   * ================================================================== */

  app.get("/api/admin/system-health", requirePerm(), (_req, res) => {
    const disp = dispatchService && typeof dispatchService.adminState === "function" ? dispatchService.adminState() : null;
    const logs = loadAuditLogs().logs || [];
    const auditIntegrity = securityRbac.verifyAuditChain(logs, process.env.JWT_SECRET || "siymon-audit-chain");
    const backups = backupLib.listBackups();
    const excState = loadExceptionsState();
    const openExceptions = (excState.cases || []).filter((c) => c.status !== "resolved").length;

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
      storage: {
        engine: "json_atomic_file_lock",
        status: "healthy",
        latestBackup: backups[0] || null,
        backupCount: backups.length,
      },
      services: {
        h3Dispatch: {
          status: "healthy",
          engine: disp?.gridEngine || "h3-js",
          mode: disp?.mode || "pull",
          onlineDrivers: disp?.drivers ? disp.drivers.filter((d) => d.dispatchState !== "offline").length : 0,
          staleDrivers: disp?.drivers ? disp.drivers.filter((d) => d.freshness === "stale").length : 0,
          pendingOrders: disp?.pending ? disp.pending.length : 0,
          alertsCount: disp?.alerts ? disp.alerts.length : 0,
        },
        roadRouting: {
          status: "configured",
          provider: process.env.ORS_API_KEY ? "OpenRouteService + OSRM fallback" : "OSRM",
        },
        reverseGeocoding: {
          status: "configured",
          provider: "Nominatim OSM",
        },
        pushNotifications: {
          status: deps.webpushEnabled ? "enabled" : "vapid_not_configured",
        },
        smsOtpProvider: {
          status: process.env.SMS_API_URL && process.env.SMS_API_KEY ? "enabled" : "sandbox_mode",
        },
      },
      integrity: {
        auditChain: auditIntegrity,
        openExceptionsCount: openExceptions,
      },
    });
  });

  app.get("/api/admin/backups", requirePerm("users.manage"), (_req, res) => {
    res.json({ ok: true, backups: backupLib.listBackups() });
  });

  app.post("/api/admin/backups", requirePerm("users.manage"), (req, res) => {
    const label = String(req.body?.label || "manual_admin_backup");
    const b = backupLib.createBackup({ label });
    logSensitive(req, { action: "backup_created", targetType: "backup", targetId: b.id, newValue: { label, fileCount: b.manifest.fileCount } });
    res.json({ ok: true, backup: { id: b.id, dir: b.dir, fileCount: b.manifest.fileCount, createdAt: b.manifest.createdAt } });
  });

  return {
    loadOtpState,
    saveOtpState,
    loadWalletState,
    saveWalletState,
    loadPromosState,
    savePromosState,
    loadExceptionsState,
    saveExceptionsState,
    loadZones,
    requirePerm,
  };
}

module.exports = { registerPlatformRoutes };
