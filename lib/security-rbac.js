"use strict";
/**
 * Authentication, Phone OTP Verification, Session Invalidation,
 * Granular Supervisor RBAC & Tamper-Evident Audit Logging (Sections 4, 19, 23)
 */
const crypto = require("crypto");

/* ------------------------------------------------------------------ *
 * Supervisor Roles & Least-Privilege Permissions
 * ------------------------------------------------------------------ */

const SUPERVISOR_ROLES = [
  "system_admin",
  "order_supervisor",
  "driver_supervisor",
  "accountant",
  "support_agent",
];

const ROLE_PERMISSIONS = {
  system_admin: ["*"],
  super_admin: ["*"], // backward-compatible alias
  admin: ["*"],       // legacy default when subRole is not restricted
  order_supervisor: [
    "orders.read",
    "orders.write",
    "orders.verify_override",
    "dispatch.read",
    "dispatch.write",
    "exceptions.read",
    "exceptions.write",
    "stores.read",
    "drivers.read",
    "customers.read",
    "notifications.read",
    "notifications.write",
    "reports.read",
    "reports.orders",
    "zones.read",
  ],
  driver_supervisor: [
    "drivers.read",
    "drivers.approve",
    "drivers.suspend",
    "drivers.documents",
    "dispatch.read",
    "dispatch.write",
    "orders.read",
    "exceptions.read",
    "exceptions.write",
    "reports.read",
    "reports.drivers",
  ],
  accountant: [
    "finance.read",
    "finance.write",
    "settlements.read",
    "settlements.write",
    "wallets.read",
    "wallets.adjust",
    "refunds.read",
    "refunds.approve",
    "topups.read",
    "topups.decide",
    "commissions.write",
    "reports.read",
    "reports.finance",
    "orders.read",
    "stores.read",
    "drivers.read",
    "exceptions.read",
    "exceptions.write",
  ],
  support_agent: [
    "support.read",
    "support.write",
    "complaints.read",
    "complaints.write",
    "ratings.moderate",
    "exceptions.read",
    "exceptions.write",
    "orders.read",
    "customers.read",
    "stores.read",
    "refunds.request",
  ],
};

function hasSupervisorPermission(adminRecord, permission) {
  if (!permission) return true;
  if (!adminRecord) return false;
  if (adminRecord.isActive === false || adminRecord.status === "suspended") return false;
  const role = String(adminRecord.subRole || adminRecord.role || "system_admin").toLowerCase();
  const basePerms = ROLE_PERMISSIONS[role] || [];
  if (basePerms.includes("*")) return true;
  if (basePerms.includes(permission)) return true;
  if (Array.isArray(adminRecord.permissions) && adminRecord.permissions.includes(permission)) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Store Employee RBAC & Escalation Prevention (Section 4)
 * ------------------------------------------------------------------ */

const STORE_EMPLOYEE_ROLES = ["owner", "manager", "cashier"];

function validateEmployeeUpdate({ actorRole, actorUserId, targetUser, patch, allPermissions }) {
  if (actorRole !== "owner") {
    return { ok: false, status: 403, error: "only_owner_can_manage_employees" };
  }
  if (targetUser && actorUserId && String(targetUser.id) === String(actorUserId)) {
    if (patch.role && patch.role !== "owner") {
      return { ok: false, status: 400, error: "cannot_demote_self" };
    }
    if (patch.isActive === false) {
      return { ok: false, status: 400, error: "cannot_disable_self" };
    }
  }
  const role = patch.role !== undefined ? String(patch.role).toLowerCase() : (targetUser ? targetUser.role : "cashier");
  if (!STORE_EMPLOYEE_ROLES.includes(role)) {
    return { ok: false, status: 400, error: "invalid_employee_role" };
  }
  let customPermissions = null;
  if (patch.permissions !== undefined) {
    if (!Array.isArray(patch.permissions)) {
      return { ok: false, status: 400, error: "invalid_permissions_list" };
    }
    const allowedSet = new Set(allPermissions || []);
    for (const p of patch.permissions) {
      if (!allowedSet.has(String(p))) {
        return { ok: false, status: 400, error: `unknown_permission:${p}` };
      }
    }
    customPermissions = [...new Set(patch.permissions.map(String))];
  }
  return { ok: true, role, customPermissions };
}

/* ------------------------------------------------------------------ *
 * Phone OTP & SMS Verification (Section 4)
 * ------------------------------------------------------------------ */

const OTP_DEFAULTS = {
  ttlMs: 5 * 60 * 1000,       // 5 minutes
  cooldownMs: 30 * 1000,      // 30s between sends to same phone
  maxPerWindow: 5,            // max 5 SMS per 15 min window per phone
  windowMs: 15 * 60 * 1000,
  maxVerifyAttempts: 5,       // lock OTP after 5 wrong tries
};

function hashOtp(phone, purpose, code, secret = "") {
  return crypto
    .createHash("sha256")
    .update(`${String(phone)}:${String(purpose)}:${String(code)}:${String(secret)}`, "utf8")
    .digest("hex");
}

function generateSixDigitCode() {
  const n = crypto.randomInt(100000, 1000000);
  return String(n);
}

/**
 * Create an OTP challenge in `state` ({ challenges: [] }).
 * Returns `{ ok: true, code, challengeId, expiresAt }` (caller sends `code` via SMS, never logs it).
 */
function createOtpChallenge(state, { phone, purpose = "verify_phone", ip = "", now = Date.now(), secret = "", opts = {} }) {
  const cfg = { ...OTP_DEFAULTS, ...opts };
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
    return { ok: false, status: 400, error: "invalid_phone" };
  }
  const cleanPurpose = String(purpose || "verify_phone").slice(0, 40);
  state.challenges = Array.isArray(state.challenges) ? state.challenges : [];

  // Prune old challenges (> 24h)
  state.challenges = state.challenges.filter((c) => now - (c.createdAt || 0) < 24 * 3600 * 1000);

  // Rate limit per phone within window
  const recentForPhone = state.challenges.filter(
    (c) => c.phone === cleanPhone && now - c.createdAt < cfg.windowMs
  );
  if (recentForPhone.length >= cfg.maxPerWindow) {
    return { ok: false, status: 429, error: "otp_rate_limit_exceeded" };
  }
  const latest = recentForPhone[0];
  if (latest && now - latest.createdAt < cfg.cooldownMs) {
    return {
      ok: false,
      status: 429,
      error: "otp_cooldown",
      retryAfterSec: Math.ceil((cfg.cooldownMs - (now - latest.createdAt)) / 1000),
    };
  }

  // Invalidate any previous unused challenge for same phone+purpose
  for (const c of state.challenges) {
    if (c.phone === cleanPhone && c.purpose === cleanPurpose && !c.usedAt && !c.invalidatedAt) {
      c.invalidatedAt = now;
    }
  }

  const code = opts.fixedCodeForTest ? String(opts.fixedCodeForTest) : generateSixDigitCode();
  const id = "OTP-" + crypto.randomBytes(6).toString("hex").toUpperCase();
  const rec = {
    id,
    phone: cleanPhone,
    purpose: cleanPurpose,
    codeHash: hashOtp(cleanPhone, cleanPurpose, code, secret),
    createdAt: now,
    expiresAt: now + cfg.ttlMs,
    attempts: 0,
    maxAttempts: cfg.maxVerifyAttempts,
    usedAt: null,
    invalidatedAt: null,
    ip: String(ip || "").slice(0, 64),
  };
  state.challenges.unshift(rec);
  return { ok: true, challengeId: id, code, expiresAt: rec.expiresAt, phone: cleanPhone, purpose: cleanPurpose };
}

/**
 * Verify an OTP code. Enforces expiry, attempt limits, and one-time use.
 */
function verifyOtpChallenge(state, { phone, purpose = "verify_phone", code, now = Date.now(), secret = "" }) {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const cleanPurpose = String(purpose || "verify_phone").slice(0, 40);
  const cleanCode = String(code || "").trim();
  if (!cleanPhone || !cleanCode || !/^\d{6}$/.test(cleanCode)) {
    return { ok: false, status: 400, error: "invalid_otp_format" };
  }
  state.challenges = Array.isArray(state.challenges) ? state.challenges : [];

  const candidate = state.challenges.find(
    (c) => c.phone === cleanPhone && c.purpose === cleanPurpose && !c.invalidatedAt
  );
  if (!candidate) {
    return { ok: false, status: 400, error: "otp_not_found" };
  }
  if (candidate.usedAt) {
    return { ok: false, status: 400, error: "otp_already_used" };
  }
  if (now > candidate.expiresAt) {
    return { ok: false, status: 400, error: "otp_expired" };
  }
  if (candidate.attempts >= (candidate.maxAttempts || OTP_DEFAULTS.maxVerifyAttempts)) {
    return { ok: false, status: 429, error: "otp_max_attempts_exceeded" };
  }

  candidate.attempts += 1;
  const expected = hashOtp(cleanPhone, cleanPurpose, cleanCode, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(candidate.codeHash || ""), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      status: 401,
      error: "otp_invalid_code",
      remainingAttempts: Math.max(0, (candidate.maxAttempts || 5) - candidate.attempts),
    };
  }

  candidate.usedAt = now;
  // Issue a short-lived verification proof token so subsequent signup/recovery/checkout can prove phone ownership
  const proofId = "VRF-" + crypto.randomBytes(8).toString("hex").toUpperCase();
  state.proofs = Array.isArray(state.proofs) ? state.proofs : [];
  state.proofs = state.proofs.filter((p) => now - (p.createdAt || 0) < 3600 * 1000);
  state.proofs.unshift({
    id: proofId,
    phone: cleanPhone,
    purpose: cleanPurpose,
    createdAt: now,
    expiresAt: now + 15 * 60 * 1000, // 15 min window to complete registration/recovery
    consumedAt: null,
  });

  return { ok: true, verified: true, phone: cleanPhone, purpose: cleanPurpose, verificationToken: proofId };
}

function consumeVerificationProof(state, { verificationToken, phone, purpose, now = Date.now() }) {
  if (!verificationToken) return { ok: false, error: "missing_verification_token" };
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  state.proofs = Array.isArray(state.proofs) ? state.proofs : [];
  const p = state.proofs.find((x) => x.id === String(verificationToken));
  if (!p) return { ok: false, error: "invalid_verification_token" };
  if (p.consumedAt) return { ok: false, error: "verification_token_already_used" };
  if (now > p.expiresAt) return { ok: false, error: "verification_token_expired" };
  if (cleanPhone && p.phone !== cleanPhone) return { ok: false, error: "verification_phone_mismatch" };
  if (purpose && p.purpose !== purpose && p.purpose !== "verify_phone") {
    return { ok: false, error: "verification_purpose_mismatch" };
  }
  p.consumedAt = now;
  return { ok: true, phone: p.phone };
}

/* ------------------------------------------------------------------ *
 * Session Revocation / Invalidation (Section 4)
 * ------------------------------------------------------------------ */

function revokeUserSessions(state, { userType, userId, reason = "logout_all", now = Date.now() }) {
  state.revokedUsers = state.revokedUsers && typeof state.revokedUsers === "object" ? state.revokedUsers : {};
  const key = `${String(userType)}:${String(userId)}`;
  // Store timestamp in seconds (matching JWT `iat`) and ms
  state.revokedUsers[key] = {
    revokedAtMs: now,
    revokedAtSec: Math.floor(now / 1000),
    reason: String(reason || "revoked"),
  };
  return state.revokedUsers[key];
}

function revokeSingleToken(state, { tokenHash, expiresAtMs, now = Date.now() }) {
  state.revokedTokens = Array.isArray(state.revokedTokens) ? state.revokedTokens : [];
  state.revokedTokens = state.revokedTokens.filter((t) => (t.expiresAtMs || now + 86400000) > now);
  if (!state.revokedTokens.some((t) => t.tokenHash === tokenHash)) {
    state.revokedTokens.unshift({ tokenHash, revokedAtMs: now, expiresAtMs: expiresAtMs || now + 7 * 86400000 });
  }
}

function isTokenRevoked(state, { tokenHash, userType, userId, iatSec }) {
  if (!state) return false;
  if (tokenHash && Array.isArray(state.revokedTokens)) {
    if (state.revokedTokens.some((t) => t.tokenHash === tokenHash)) return true;
  }
  if (userType && userId && state.revokedUsers) {
    const entry = state.revokedUsers[`${String(userType)}:${String(userId)}`];
    if (entry && iatSec && iatSec < entry.revokedAtSec) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Tamper-Evident Sensitive Audit Log Chain (Sections 4, 19, 21, 23)
 * ------------------------------------------------------------------ */

function computeAuditHash(entry, prevHash = "GENESIS", secret = "") {
  const payload = JSON.stringify({
    id: entry.id,
    at: entry.at,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action || entry.path,
    targetType: entry.targetType || null,
    targetId: entry.targetId || null,
    prevHash: prevHash || "GENESIS",
  });
  return crypto
    .createHmac("sha256", String(secret || "siymon-audit-chain"))
    .update(payload, "utf8")
    .digest("hex");
}

function createTamperEvidentAuditEntry(entry, prevEntry, secret = "") {
  const prevHash = prevEntry && prevEntry.chainHash ? prevEntry.chainHash : "GENESIS";
  const rec = {
    ...entry,
    prevHash,
  };
  rec.chainHash = computeAuditHash(rec, prevHash, secret);
  return rec;
}

function verifyAuditChain(logs, secret = "") {
  if (!Array.isArray(logs) || logs.length === 0) return { ok: true, checked: 0 };
  // Logs are stored newest-first (unshift). Only entries with chainHash participate in the chain.
  const chained = logs.filter((l) => l && l.chainHash).slice().reverse();
  let prevHash = "GENESIS";
  for (let i = 0; i < chained.length; i++) {
    const item = chained[i];
    if (i > 0 && item.prevHash !== prevHash) {
      return { ok: false, brokenAtId: item.id, reason: "prev_hash_mismatch" };
    }
    const expected = computeAuditHash(item, item.prevHash || "GENESIS", secret);
    if (expected !== item.chainHash) {
      return { ok: false, brokenAtId: item.id, reason: "hash_tampered" };
    }
    prevHash = item.chainHash;
  }
  return { ok: true, checked: chained.length };
}

module.exports = {
  SUPERVISOR_ROLES,
  ROLE_PERMISSIONS,
  STORE_EMPLOYEE_ROLES,
  OTP_DEFAULTS,
  hasSupervisorPermission,
  validateEmployeeUpdate,
  createOtpChallenge,
  verifyOtpChallenge,
  consumeVerificationProof,
  revokeUserSessions,
  revokeSingleToken,
  isTokenRevoked,
  createTamperEvidentAuditEntry,
  verifyAuditChain,
};
