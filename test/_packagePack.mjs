// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared by the packaging smokes: `npm pack` this package (lifecycle scripts RUN, so prepack builds types/ exactly as
// a publish would) into a fresh temp directory and list its files.
//
// The smokes share one tarball per package state. Its key hashes every byte a pack can read -- each regular file at the
// package root and every file under each `files` entry -- taken after prepack has brought types/ up to date, so a stored
// tarball is the one `npm pack` would make of the package as it is now. Each caller still gets its own copy in its own
// temp directory. The packs are serialized by a lock, which also keeps two prepacks from rewriting types/ together.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function npmPack(dest) {
  const r = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (r.error) throw new Error(`npm pack could not start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`npm pack failed (${r.status}): ${(r.stderr || '').slice(-600)}`);
  const out = r.stdout.slice(r.stdout.indexOf('['));
  return JSON.parse(out)[0];
}
const result = (dest, info) => ({
  dest,
  tgz: path.join(dest, info.filename),
  files: info.files.map((f) => f.path),
  size: info.size,
  unpackedSize: info.unpackedSize,
});

// ---- the shared tarball ---------------------------------------------------------------------------
const MEMO = path.join(os.tmpdir(), 'mantle-pack-memo');
const LOCK = path.join(MEMO, 'lock');
// a lock older than the node lane's per-test cap (runNodeChecks' SMOKE_TIMEOUT_MS) outlived its holder
const LANE_CAP_MS =
  Number(process.env.SMOKE_TIMEOUT_MS) > 0 ? Number(process.env.SMOKE_TIMEOUT_MS) : 180000;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the process exists
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
function lockStale() {
  let age = 0,
    pid = 0;
  try {
    age = Date.now() - statSync(LOCK).mtimeMs;
    pid = Number(readFileSync(path.join(LOCK, 'pid'), 'utf8'));
  } catch {
    /* no pid yet: the holder is between its mkdir and its write */
  }
  return age > LANE_CAP_MS || (pid > 0 && !alive(pid)) || (!pid && age > 10000);
}
function withLock(fn) {
  mkdirSync(MEMO, { recursive: true });
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (lockStale()) rmSync(LOCK, { recursive: true, force: true });
    else nap(100);
  }
  try {
    writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
    return fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

// Every file a pack can read: the regular files at the root, and everything under each `files` entry (a glob's
// directory part, so the set only ever grows). Null without a `files` list (npm would pack the whole tree) or when an
// entry has no directory to bound it.
function packInputs() {
  const pkg = packageJson(),
    out = new Set();
  if (!Array.isArray(pkg.files) || !pkg.files.length) return null;
  for (const e of readdirSync(PKG_DIR, { withFileTypes: true })) if (e.isFile()) out.add(e.name);
  const walk = (rel) => {
    const abs = path.join(PKG_DIR, rel);
    if (!existsSync(abs)) return;
    const st = lstatSync(abs);
    if (st.isDirectory()) for (const n of readdirSync(abs)) walk(path.join(rel, n));
    else if (st.isFile()) out.add(rel);
  };
  for (const f of pkg.files || []) {
    const root = f.split(/[*?[{]/)[0].replace(/\/+$/, '');
    if (!root || root.startsWith('.')) return null;
    walk(root);
  }
  return [...out].sort();
}
function packKey() {
  const files = packInputs();
  if (!files) return null;
  const h = createHash('sha256').update(process.version + '\0');
  const npmCli = path.join(path.dirname(process.execPath), '../lib/node_modules/npm/package.json');
  if (existsSync(npmCli)) h.update(readFileSync(npmCli));
  for (const f of files) h.update(f + '\0').update(readFileSync(path.join(PKG_DIR, f)));
  return h.digest('hex').slice(0, 32);
}
// An entry serves for an hour, which bounds what it can miss (a toolchain change, say) to a lane run's own span.
const FRESH_MS = 3600000;
const fresh = (p) => Date.now() - statSync(p).mtimeMs < FRESH_MS;
function prune(keep) {
  for (const n of readdirSync(MEMO)) {
    const p = path.join(MEMO, n);
    if (n === 'lock' || n === keep) continue;
    try {
      if (!fresh(p)) rmSync(p, { recursive: true, force: true });
    } catch {
      /* another run pruned it */
    }
  }
}
// The shared tarball copied into `dest`, with its npm pack info; null when the package cannot be keyed.
function sharedPack(dest) {
  return withLock(() => {
    const pre = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts/prepack.mjs')], {
      cwd: PKG_DIR,
      encoding: 'utf8',
    });
    if (pre.status !== 0) return null; // a fresh pack reports the failure as npm would
    const key = packKey();
    if (!key) return null;
    const dir = path.join(MEMO, key),
      infoFile = path.join(dir, 'info.json');
    if (existsSync(infoFile) && !fresh(infoFile)) rmSync(dir, { recursive: true, force: true });
    if (!existsSync(infoFile)) {
      const tmp = mkdtempSync(path.join(MEMO, 'tmp-'));
      const info = npmPack(tmp);
      if (packKey() !== key) {
        // the package changed while it packed: this tarball belongs to no single state
        rmSync(tmp, { recursive: true, force: true });
        return null;
      }
      writeFileSync(path.join(tmp, 'info.json'), JSON.stringify(info));
      renameSync(tmp, dir);
    }
    prune(key);
    const info = JSON.parse(readFileSync(infoFile, 'utf8'));
    copyFileSync(path.join(dir, info.filename), path.join(dest, info.filename));
    return info;
  });
}

export function packPackage() {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'mantle-pack-'));
  let info = null;
  try {
    info = sharedPack(dest);
  } catch {
    info = null;
  }
  return result(dest, info || npmPack(dest));
}

export function packageJson() {
  return JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
}
