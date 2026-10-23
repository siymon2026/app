/*
  Production prestart checks & optional DB bootstrap.

  What it does:
  - Validates critical env vars (JWT_SECRET, PORT, and optionally DATABASE_URL)
  - Ensures logs/uploads dirs exist
  - If DATABASE_URL is set (or REQUIRE_DATABASE_URL=1), it will:
      - prisma generate
      - prisma db push  (because this repo doesn't ship prisma migrations yet)
      - migrate JSON -> DB (best-effort upsert)

  Notes:
  - This script is safe to run multiple times.
  - You can disable any step using env flags below.
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config();

const ROOT = path.join(__dirname, "..");
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

function die(msg) {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

function requireNonEmpty(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) die(`${name} is required`);
  return v;
}

function ensureInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (fallback !== undefined) return fallback;
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 65535) {
    die(`${name} must be an integer between 1 and 65535`);
  }
  return n;
}

// --- Validate env ---
if (isProd) {
  requireNonEmpty("JWT_SECRET");
}
ensureInt("PORT", 3000);

const requireDb = String(process.env.REQUIRE_DATABASE_URL || "").trim() === "1";
const hasDb = Boolean(String(process.env.DATABASE_URL || "").trim());
if (requireDb && !hasDb) {
  die("DATABASE_URL is required (REQUIRE_DATABASE_URL=1)");
}

// --- Ensure dirs ---
const uploadsDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : (isProd ? path.join(ROOT, "uploads") : path.join(ROOT, "public", "uploads"));

const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(ROOT, "logs");

try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_e) {}
try { fs.mkdirSync(logDir, { recursive: true }); } catch (_e) {}

// --- Optional Prisma + JSON->DB bootstrap ---
// Because prisma CLI must exist at runtime, we keep prisma in dependencies.
const prismaEnabled = String(process.env.PRISMA_BOOTSTRAP || (hasDb ? "1" : "0")) === "1";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed with code ${r.status}`);
}

if (prismaEnabled && hasDb) {
  const doGenerate = String(process.env.PRISMA_GENERATE || "1") === "1";
  const doDbPush = String(process.env.PRISMA_DB_PUSH || "1") === "1";
  const doJson2Db = String(process.env.AUTO_JSON_MIGRATION || "1") === "1";

  try {
    if (doGenerate) run("npx", ["prisma", "generate"]);
    if (doDbPush) run("npx", ["prisma", "db", "push"]);
    if (doJson2Db) run("node", ["scripts/migrate-json-to-db.js"]);
  } catch (e) {
    // In production, prefer failing fast if DB is expected.
    if (isProd && (requireDb || String(process.env.FAIL_ON_DB_BOOTSTRAP_ERROR || "1") === "1")) {
      die(e.message || String(e));
    }
    console.warn(`[WARN] DB bootstrap skipped/failed: ${e.message || e}`);
  }
}

console.log("[OK] prestart checks done");
