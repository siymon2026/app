"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rbac = require("../lib/security-rbac");
const backup = require("../lib/backup");

test("supervisor RBAC enforces granular role permissions", () => {
  assert.equal(rbac.hasSupervisorPermission({ role: "system_admin" }, "system.settings"), true);
  assert.equal(rbac.hasSupervisorPermission({ role: "system_admin" }, "settlements.write"), true);

  assert.equal(rbac.hasSupervisorPermission({ subRole: "order_supervisor" }, "orders.write"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "order_supervisor" }, "orders.verify_override"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "order_supervisor" }, "settlements.write"), false);

  assert.equal(rbac.hasSupervisorPermission({ subRole: "driver_supervisor" }, "drivers.approve"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "driver_supervisor" }, "drivers.documents"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "driver_supervisor" }, "refunds.approve"), false);

  assert.equal(rbac.hasSupervisorPermission({ subRole: "accountant" }, "settlements.write"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "accountant" }, "reports.finance"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "accountant" }, "drivers.approve"), false);

  assert.equal(rbac.hasSupervisorPermission({ subRole: "support_agent" }, "exceptions.write"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "support_agent" }, "ratings.moderate"), true);
  assert.equal(rbac.hasSupervisorPermission({ subRole: "support_agent" }, "settlements.write"), false);
});

test("store employee assignment prevents privilege escalation and self-demotion", () => {
  const ok = rbac.validateEmployeeUpdate({
    actorRole: "owner",
    actorUserId: "u_owner",
    targetUser: { id: "u_staff", role: "cashier" },
    patch: { role: "manager", isActive: true },
  });
  assert.equal(ok.ok, true);

  const nonOwner = rbac.validateEmployeeUpdate({
    actorRole: "manager",
    actorUserId: "u_mgr",
    targetUser: { id: "u_staff", role: "cashier" },
    patch: { role: "owner" },
  });
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.error, "only_owner_can_manage_employees");

  const selfDemote = rbac.validateEmployeeUpdate({
    actorRole: "owner",
    actorUserId: "u_owner",
    targetUser: { id: "u_owner", role: "owner" },
    patch: { role: "cashier" },
  });
  assert.equal(selfDemote.ok, false);
  assert.equal(selfDemote.error, "cannot_demote_self");
});

test("OTP flow enforces rate limits, expiry, attempt limits, and one-time use", () => {
  const state = { challenges: [], proofs: [] };
  const now = 1_700_000_000_000;

  const c1 = rbac.createOtpChallenge(state, { phone: "0612345678", purpose: "login", now });
  assert.equal(c1.ok, true);
  assert.equal(c1.phone, "0612345678");
  assert.match(c1.code, /^\d{6}$/);

  // Wrong code increments attempts
  const bad = rbac.verifyOtpChallenge(state, { phone: "0612345678", purpose: "login", code: "000000", now: now + 1000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "otp_invalid_code");
  assert.equal(bad.remainingAttempts, 4);

  // Correct code succeeds once and returns a proof token
  const ok = rbac.verifyOtpChallenge(state, { phone: "0612345678", purpose: "login", code: c1.code, now: now + 2000 });
  assert.equal(ok.ok, true);
  assert.ok(ok.verificationToken);

  // Proof token can be consumed once
  const proof1 = rbac.consumeVerificationProof(state, {
    verificationToken: ok.verificationToken,
    phone: "0612345678",
    purpose: "login",
    now: now + 2500,
  });
  assert.equal(proof1.ok, true);

  // Replay of same code fails (one-time use)
  const replay = rbac.verifyOtpChallenge(state, { phone: "0612345678", purpose: "login", code: c1.code, now: now + 3000 });
  assert.equal(replay.ok, false);

  // Cooldown prevents immediate resend within 60s
  const cooldown = rbac.createOtpChallenge(state, { phone: "0612345678", purpose: "login", now: now + 5000 });
  assert.equal(cooldown.ok, false);
  assert.equal(cooldown.error, "otp_cooldown");
});

test("session revocation invalidates tokens issued before revocation timestamp", () => {
  const state = { revokedUsers: {}, revokedTokens: [] };
  rbac.revokeUserSessions(state, { userType: "customer", userId: "cust_1", now: 2000 });
  assert.equal(rbac.isTokenRevoked(state, { userType: "customer", userId: "cust_1", iatSec: 1 }), true);
  assert.equal(rbac.isTokenRevoked(state, { userType: "customer", userId: "cust_1", iatSec: 3 }), false);
});

test("tamper-evident audit log chain detects unauthorized modification or deletion", () => {
  const logs = [];
  const secret = "test-audit-secret";
  const e1 = rbac.createTamperEvidentAuditEntry(
    { id: "a1", at: "2026-10-23T10:00:00Z", action: "order_accept", actorType: "store", actorId: "s1", targetId: "o1" },
    logs[0] || null,
    secret
  );
  logs.unshift(e1);
  const e2 = rbac.createTamperEvidentAuditEntry(
    { id: "a2", at: "2026-10-23T10:01:00Z", action: "driver_assign", actorType: "admin", actorId: "adm1", targetId: "o1" },
    logs[0] || null,
    secret
  );
  logs.unshift(e2);

  assert.equal(logs.length, 2);
  assert.equal(rbac.verifyAuditChain(logs, secret).ok, true);

  // Tamper with first entry
  logs[1].targetId = "o999";
  const check = rbac.verifyAuditChain(logs, secret);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "hash_tampered");
});

test("backup module creates, verifies, lists, and restores SHA-256 verified snapshots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siymon-bkp-test-"));
  const dataDir = path.join(tmp, "data");
  const backupRoot = path.join(tmp, "backups");
  fs.mkdirSync(dataDir, { recursive: true });
  const ordersPath = path.join(dataDir, "orders.json");
  fs.writeFileSync(ordersPath, JSON.stringify({ orders: [{ id: "ord_1", total: 95 }] }));

  const created = backup.createBackup({ rootDir: tmp, dataDir, backupRoot, label: "unit_test" });
  assert.equal(created.ok, true);
  assert.equal(created.manifest.fileCount, 1);

  const verified = backup.verifyBackup({ backupDir: created.path });
  assert.equal(verified.ok, true);

  const list = backup.listBackups({ dataDir, backupRoot });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  // Modify live file and restore from backup
  fs.writeFileSync(ordersPath, JSON.stringify({ orders: [] }));
  const restored = backup.restoreBackup({ backupId: created.id, rootDir: tmp, dataDir, backupRoot });
  assert.equal(restored.ok, true);
  const afterRestore = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
  assert.equal(afterRestore.orders.length, 1);
  assert.equal(afterRestore.orders[0].id, "ord_1");

  fs.rmSync(tmp, { recursive: true, force: true });
});
