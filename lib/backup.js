"use strict";
/**
 * Data Protection & Backup Utility (Section 21)
 * Creates verified, checksummed backups of JSON data files and config before
 * sensitive changes or migrations, and supports verified restoration.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function createBackup({ rootDir, dataDir, backupRoot, label = "manual", actorId = "system" }) {
  const root = path.resolve(rootDir || path.join(__dirname, ".."));
  const dDir = path.resolve(dataDir || path.join(root, "data"));
  const bRoot = path.resolve(backupRoot || path.join(dDir, "backups"));

  fs.mkdirSync(bRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = String(label || "backup").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const backupId = `bkp_${ts}_${safeLabel}`;
  const destDir = path.join(bRoot, backupId);
  fs.mkdirSync(destDir, { recursive: true });

  const files = [];

  // 1. Backup data/*.json if dataDir exists
  if (fs.existsSync(dDir)) {
    for (const entry of fs.readdirSync(dDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const src = path.join(dDir, entry.name);
      const dst = path.join(destDir, entry.name);
      fs.copyFileSync(src, dst);
      const hash = sha256File(src);
      const stat = fs.statSync(src);
      files.push({ name: entry.name, scope: "data", size: stat.size, sha256: hash });
    }
  }

  // 2. Backup config.json if it exists
  const cfgPath = path.join(root, "config.json");
  if (fs.existsSync(cfgPath)) {
    const dst = path.join(destDir, "_root_config.json");
    fs.copyFileSync(cfgPath, dst);
    const hash = sha256File(cfgPath);
    const stat = fs.statSync(cfgPath);
    files.push({ name: "_root_config.json", original: "config.json", scope: "root", size: stat.size, sha256: hash });
  }

  // 3. Backup prisma/schema.prisma if it exists
  const schemaPath = path.join(root, "prisma", "schema.prisma");
  if (fs.existsSync(schemaPath)) {
    const dst = path.join(destDir, "_schema.prisma");
    fs.copyFileSync(schemaPath, dst);
    const hash = sha256File(schemaPath);
    const stat = fs.statSync(schemaPath);
    files.push({ name: "_schema.prisma", original: "prisma/schema.prisma", scope: "prisma", size: stat.size, sha256: hash });
  }

  const manifest = {
    id: backupId,
    label: safeLabel,
    createdAt: new Date().toISOString(),
    actorId: String(actorId || "system"),
    fileCount: files.length,
    files,
  };

  const manifestPath = path.join(destDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  // 4. Verify backup immediately
  const verification = verifyBackup({ backupDir: destDir });
  if (!verification.ok) {
    throw new Error(`Backup verification failed: ${verification.error}`);
  }

  return { ok: true, id: backupId, path: destDir, manifest, verified: true };
}

function verifyBackup({ backupDir }) {
  try {
    const manifestPath = path.join(backupDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: "manifest_missing" };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!Array.isArray(manifest.files)) {
      return { ok: false, error: "invalid_manifest" };
    }
    for (const f of manifest.files) {
      const p = path.join(backupDir, path.basename(f.name));
      if (!fs.existsSync(p)) {
        return { ok: false, error: `missing_file:${f.name}` };
      }
      const actualHash = sha256File(p);
      if (actualHash !== f.sha256) {
        return { ok: false, error: `checksum_mismatch:${f.name}` };
      }
    }
    return { ok: true, id: manifest.id, fileCount: manifest.files.length, createdAt: manifest.createdAt };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function listBackups({ dataDir, backupRoot } = {}) {
  const bRoot = path.resolve(backupRoot || path.join(dataDir || "data", "backups"));
  if (!fs.existsSync(bRoot)) return [];
  const out = [];
  for (const entry of fs.readdirSync(bRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(bRoot, entry.name);
    const mPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(mPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mPath, "utf-8"));
      const v = verifyBackup({ backupDir: dir });
      out.push({
        id: m.id || entry.name,
        label: m.label || "",
        createdAt: m.createdAt || null,
        actorId: m.actorId || "",
        fileCount: m.fileCount || 0,
        verified: v.ok,
      });
    } catch (_e) {}
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function restoreBackup({ backupId, rootDir, dataDir, backupRoot }) {
  const root = path.resolve(rootDir || path.join(__dirname, ".."));
  const dDir = path.resolve(dataDir || path.join(root, "data"));
  const bRoot = path.resolve(backupRoot || path.join(dDir, "backups"));
  const safeId = path.basename(String(backupId || ""));
  const srcDir = path.join(bRoot, safeId);

  const v = verifyBackup({ backupDir: srcDir });
  if (!v.ok) return { ok: false, error: v.error };

  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf-8"));
  fs.mkdirSync(dDir, { recursive: true });

  let restored = 0;
  for (const f of manifest.files) {
    const src = path.join(srcDir, path.basename(f.name));
    if (f.scope === "data") {
      const dst = path.join(dDir, path.basename(f.name));
      fs.copyFileSync(src, dst);
      restored++;
    } else if (f.scope === "root" && f.name === "_root_config.json") {
      const dst = path.join(root, "config.json");
      fs.copyFileSync(src, dst);
      restored++;
    }
  }
  return { ok: true, id: safeId, restored };
}

module.exports = {
  sha256File,
  createBackup,
  verifyBackup,
  listBackups,
  restoreBackup,
};
