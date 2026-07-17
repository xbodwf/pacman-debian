import * as fs from 'node:fs';
import * as path from 'node:path';
import { initDb, loadDatabase, saveDatabase, removePkg, getPackage, runScript } from '../db/database';
import { readDpkgStatus, removeDpkgEntry } from '../db/dpkg-compat';
import { acquireDpkgLock, releaseDpkgLock } from '../lock/dpkg-lock';
import { confirm } from '../ui/prompt';
import type { RemoveOptions } from '../core/options';
import type { Database } from '../core/types';
import { t } from '../i18n';
import { color } from '../ui/colors';

const DPKG_INFO = '/var/lib/dpkg/info';
const LOCAL_DIR = '/var/lib/pacman-debian/local';

function getDpkgPackage(name: string): import('../core/types').InstalledPackage | undefined {
  const entry = readDpkgStatus().get(name);
  if (!entry) return undefined;
  const listPath = path.join(DPKG_INFO, `${name}.list`);
  let files: string[] = [];
  try { files = fs.readFileSync(listPath, 'utf8').split('\n').filter(Boolean); } catch {}
  return {
    name: entry.package,
    version: entry.version,
    architecture: entry.architecture || process.arch,
    description: entry.description || '',
    depends: entry.depends,
    maintainer: entry.maintainer,
    homepage: entry.homepage,
    controlSection: entry.section,
    controlPriority: entry.priority,
    installedSize: entry.installedSize,
    installTime: 0,
    reason: 'explicit',
    files,
    repoType: 'debian',
  };
}

/** 暴力扫 local/ 目录删除指定包的数据 */
function purgeLocalDir(name: string): void {
  if (!fs.existsSync(LOCAL_DIR)) return;
  for (const entry of fs.readdirSync(LOCAL_DIR)) {
    if (entry === 'by-name') continue;
    // 匹配 name-version，version 以数字开头：非贪婪取 name
    const m = entry.match(/^(.+?)-(\d.*)$/);
    if (m && m[1] === name) {
      try { fs.rmSync(path.join(LOCAL_DIR, entry), { recursive: true }); } catch {}
      try { fs.unlinkSync(path.join(LOCAL_DIR, 'by-name', name)); } catch {}
    }
  }
}

/** Read conffiles list from dpkg for a package, if available. */
function getConffiles(pkgName: string): string[] {
  const fp = path.join(DPKG_INFO, `${pkgName}.conffiles`);
  try {
    const content = fs.readFileSync(fp, 'utf8');
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  } catch {
    return [];
  }
}

/** Extract base package names from a depends string (Debian format). */
function parseDepNames(s?: string): string[] {
  if (!s) return [];
  const names = new Set<string>();
  for (const part of s.split(',')) {
    const alt = part.trim().split('|')[0].trim();
    const m = alt.match(/^([\w.+\-:]+)/);
    if (m) {
      const n = m[1].replace(/:.{1,8}$/, ''); // strip arch qualifier
      names.add(n);
    }
  }
  return [...names];
}

/** Check if any package in the database (excluding a given set) depends on `name`. */
function isRequiredByOthers(name: string, excluding: Set<string>, db: Database): boolean {
  for (const [, pkg] of db.packages) {
    if (excluding.has(pkg.name)) continue;
    for (const d of parseDepNames(pkg.depends)) {
      if (d === name) return true;
    }
    for (const d of parseDepNames(pkg['pre-depends'])) {
      if (d === name) return true;
    }
  }
  return false;
}

/**
 * BFS to collect all packages to remove.
 *
 * - `recursive` (Rs): walk dependency tree, remove orphaned deps (not needed by others)
 * - `cascade` (Rsc): also walk reverse-deps, remove pkgs that depend on the target
 * - default (R): only the target itself
 */
function collectRemoveSet(target: string, opts: RemoveOptions, db: Database): string[] {
  const toRemove = new Set<string>();
  const queue = [target];

  if (opts.cascade || opts.recursive) {
    // Phase 1: cascade upward — find all pkgs that depend on the target or its dependents
    if (opts.cascade) {
      for (let i = 0; i < queue.length; i++) {
        const name = queue[i];
        for (const [, pkg] of db.packages) {
          if (toRemove.has(pkg.name) || pkg.name === name) continue;
          if (parseDepNames(pkg.depends).includes(name) || parseDepNames(pkg['pre-depends']).includes(name)) {
            toRemove.add(pkg.name);
            queue.push(pkg.name);
          }
        }
      }
    }

    // Phase 2: walk dependency tree, remove orphans
    toRemove.add(target);
    for (let i = 0; i < queue.length; i++) {
      const name = queue[i];
      const pkg = getPackage(db, name);
      if (!pkg) continue;

      for (const d of parseDepNames(pkg.depends)) {
        if (toRemove.has(d)) continue;
        const dp = getPackage(db, d);
        if (!dp) continue;
        // Only remove if this dep won't be needed by remaining packages
        if (!isRequiredByOthers(d, new Set([...toRemove, d]), db)) {
          toRemove.add(d);
          queue.push(d);
        }
      }
      // Same for Pre-Depends
      for (const d of parseDepNames(pkg['pre-depends'])) {
        if (toRemove.has(d)) continue;
        const dp = getPackage(db, d);
        if (!dp) continue;
        if (!isRequiredByOthers(d, new Set([...toRemove, d]), db)) {
          toRemove.add(d);
          queue.push(d);
        }
      }
    }
  } else {
    // Simple remove: just the target (nodeps check is done elsewhere)
    toRemove.add(target);
  }

  return [...toRemove].reverse(); // reverse so leaf deps are removed first
}

async function removeSingle(name: string, opts: RemoveOptions = {}, onPkgProgress?: (done: number, total: number) => void): Promise<boolean> {
  initDb();
  const db = loadDatabase();
  const pkg = getPackage(db, name) || getDpkgPackage(name);
  if (!pkg) { console.error(color.error(t('error_not_installed', name))); return false; }

  // Collect everything to remove
  const toRemove = collectRemoveSet(name, opts, db);
  const noDeps = opts.nodeps && !opts.recursive && !opts.cascade;

  if (!noDeps && !opts.recursive && !opts.cascade) {
    // Check if any other package depends on this one
    if (isRequiredByOthers(name, new Set([name]), db)) {
      console.error(`${color.error('error')}: failed to prepare transaction (could not satisfy dependencies)\n  :: ${color.pkg(name)} is required by some other package`);
      console.error('  (use -Rdd to skip this check, or -Rs to remove orphans)');
      return false;
    }
  }

  await acquireDpkgLock();
  try {
  for (const n of toRemove) {
    const p = getPackage(db, n) || getDpkgPackage(n);
    if (!p) continue;

    if (!opts.noscriptlet) runScript(n, 'prerm', ['remove']);

    // If nosave=false (no -n flag), back up conffiles before deletion
    const conffiles = new Set(!opts.nosave ? getConffiles(n) : []);

    const totalFiles = p.files.length;
    let doneFiles = 0;
    for (const f of p.files) {
      try {
        if (fs.existsSync(f)) {
          const owner = db.fileIndex.get(f);
          if (owner && owner !== n) { doneFiles++; onPkgProgress?.(doneFiles, totalFiles); continue; }
          const s = fs.lstatSync(f);
          if (s.isDirectory()) { try { fs.rmdirSync(f); } catch {} }
          else {
            if (conffiles.has(f)) {
              const backup = f + '.dpkg-old';
              try { fs.renameSync(f, backup); } catch { fs.unlinkSync(f); }
            } else {
              fs.unlinkSync(f);
            }
          }
        }
      } catch {}
      doneFiles++;
      if (onPkgProgress) onPkgProgress(doneFiles, totalFiles);
    }

    if (!opts.noscriptlet) runScript(n, 'postrm', ['remove']);

    try { await removeDpkgEntry(n); } catch {}
    removePkg(db, n);

    // 暴力清理：确保目录被删（removePkg 有时不生效）
    purgeLocalDir(n);
  }

  saveDatabase(db);
  return true;
  } finally { releaseDpkgLock(); }
}

export async function removeByName(name: string, opts: RemoveOptions = {}): Promise<boolean> {
  initDb();
  const db = loadDatabase();
  const pkg = getPackage(db, name) || getDpkgPackage(name);
  if (!pkg) { console.error(color.error(t('error_not_installed', name))); return false; }

  // Collect removal set for display
  const toRemove = collectRemoveSet(name, opts, db);

  if (opts.print) {
    for (const n of toRemove) {
      const p = getPackage(db, n) || getDpkgPackage(n);
      if (p) console.log(t('would_remove', `${n}-${p.version}`));
    }
    return true;
  }

  if (!opts.nodeps && !opts.recursive && !opts.cascade) {
    if (isRequiredByOthers(name, new Set([name]), db)) {
      console.error(`${color.error('error')}: failed to prepare transaction (could not satisfy dependencies)\n  :: ${color.pkg(name)} is required by some other package`);
      console.error('  (use -Rdd to skip this check, or -Rs to remove orphans)');
      return false;
    }
  }

  console.log(t('checking_deps_remove') + '\n');
  console.log(`${color.title('Packages')} (${toRemove.length}): ${toRemove.map(n => color.pkg(n)).join('  ')}`);
  console.log('');

  if (!await confirm(':: Proceed with removal?', false)) return true;

  if (opts.recursive || opts.cascade) {
    const cols = process.stdout.columns || 80;
    const barLen = Math.max((cols - 55), 5);
    await acquireDpkgLock();
    try {
      for (let i = 0; i < toRemove.length; i++) {
        const n = toRemove[i];
        const p = getPackage(db, n) || getDpkgPackage(n);
        if (!p) continue;
        const pname = `${n}-${p.version}`;
        const fmtLine = (pct: number) => {
          const filled = Math.round((pct / 100) * barLen);
          const bar = '#'.repeat(filled) + '-'.repeat(barLen - filled);
          return `(${i + 1}/${toRemove.length}) removing ${pname.padEnd(Math.max(20, cols - 65))} [${bar}] ${String(pct).padStart(3)}%`;
        };
        process.stdout.write(fmtLine(0));
        const removed = await removeSingle(n, { ...opts, recursive: false, cascade: false, nodeps: true },
          (done, total) => { process.stdout.write('\r\x1b[K' + fmtLine(Math.round(done / total * 100))); });
        if (!removed) return false;
        process.stdout.write('\r\x1b[K' + fmtLine(100) + '\n');
      }
    } finally {
      releaseDpkgLock();
    }
    console.log(t('pkg_removed', name));
    return true;
  }

  const result = await removeSingle(name, opts);
  if (!result) return false;
  console.log(t('pkg_removed', name));
  return true;
}

export async function removePackages(names: string[], opts: RemoveOptions = {}): Promise<boolean> {
  initDb();
  const db = loadDatabase();
  const allToRemove = new Set<string>();

  for (const name of names) {
    const pkg = getPackage(db, name) || getDpkgPackage(name);
    if (!pkg) { console.error(color.error(t('error_not_installed', name))); return false; }
    const set = collectRemoveSet(name, opts, db);
    for (const s of set) allToRemove.add(s);
  }

  const list = [...allToRemove];
  if (list.length === 0) { console.error(color.error(t('error_no_targets'))); return false; }

  if (opts.print) {
    for (const n of list) {
      const p = getPackage(db, n) || getDpkgPackage(n);
      if (p) console.log(t('would_remove', `${n}-${p.version}`));
    }
    return true;
  }

  // Dep check for simple remove (non-recursive, non-cascade)
  if (!opts.nodeps && !opts.recursive && !opts.cascade) {
    for (const name of names) {
      if (isRequiredByOthers(name, new Set(names), db)) {
        console.error(`${color.error('error')}: failed to prepare transaction (could not satisfy dependencies)\n  :: ${color.pkg(name)} is required by some other package`);
        console.error('  (use -Rdd to skip this check, or -Rs to remove orphans)');
        return false;
      }
    }
  }

  console.log(t('checking_deps_remove') + '\n');
  console.log(`${color.title('Packages')} (${list.length}): ${list.map(n => color.pkg(n)).join('  ')}`);
  console.log('');

  if (!await confirm(':: Proceed with removal?', false)) return true;

  const cols = process.stdout.columns || 80;
  const barLen = Math.max((cols - 55), 5);
  await acquireDpkgLock();
  try {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const p = getPackage(db, n) || getDpkgPackage(n);
      if (!p) continue;
      const pname = `${n}-${p.version}`;
      const fmtLine = (pct: number) => {
        const filled = Math.round((pct / 100) * barLen);
        const bar = '#'.repeat(filled) + '-'.repeat(barLen - filled);
        return `(${i + 1}/${list.length}) removing ${pname.padEnd(Math.max(20, cols - 65))} [${bar}] ${String(pct).padStart(3)}%`;
      };
      if (list.length > 1) process.stdout.write(fmtLine(0));
      const removed = await removeSingle(n, { ...opts, recursive: false, cascade: false, nodeps: true },
        (done, total) => { process.stdout.write('\r\x1b[K' + fmtLine(Math.round(done / total * 100))); });
      if (!removed) return false;
      if (list.length > 1) process.stdout.write('\r\x1b[K' + fmtLine(100) + '\n');
    }
  } finally {
    releaseDpkgLock();
  }

  if (list.length === 1) console.log(t('pkg_removed', list[0]));
  return true;
}
