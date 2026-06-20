import * as fs from 'node:fs';
import * as path from 'node:path';
import { initDb, loadDatabase, saveDatabase, removePkg, getPackage, runScript } from '../db/database';
import { removeDpkgEntry } from '../db/dpkg-compat';
import { confirm } from '../ui/prompt';
import type { RemoveOptions } from '../core/options';
import type { Database } from '../core/types';
import { t } from '../i18n';

const DPKG_INFO = '/var/lib/dpkg/info';

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

function removeSingle(name: string, opts: RemoveOptions = {}): boolean {
  initDb();
  const db = loadDatabase();
  const pkg = getPackage(db, name);
  if (!pkg) { console.error(t('error_not_installed', name)); return false; }

  // Collect everything to remove
  const toRemove = collectRemoveSet(name, opts, db);
  const noDeps = opts.nodeps && !opts.recursive && !opts.cascade;

  if (!noDeps && !opts.recursive && !opts.cascade) {
    // Check if any other package depends on this one
    if (isRequiredByOthers(name, new Set([name]), db)) {
      console.error(`error: failed to prepare transaction (could not satisfy dependencies)\n  :: ${name} is required by some other package`);
      console.error('  (use -Rdd to skip this check, or -Rs to remove orphans)');
      return false;
    }
  }

  for (const n of toRemove) {
    const p = getPackage(db, n);
    if (!p) continue;

    if (!opts.noscriptlet) runScript(n, 'prerm', ['remove']);

    // If nosave=false (no -n flag), back up conffiles before deletion
    const conffiles = new Set(!opts.nosave ? getConffiles(n) : []);

    for (const f of p.files) {
      try {
        if (fs.existsSync(f)) {
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
    }

    if (!opts.noscriptlet) runScript(n, 'postrm', ['remove']);

    try { removeDpkgEntry(n); } catch {}
    removePkg(db, n);
  }

  saveDatabase(db);
  return true;
}

export async function removeByName(name: string, opts: RemoveOptions = {}): Promise<boolean> {
  initDb();
  const db = loadDatabase();
  const pkg = getPackage(db, name);
  if (!pkg) { console.error(t('error_not_installed', name)); return false; }

  // Collect removal set for display
  const toRemove = collectRemoveSet(name, opts, db);

  if (opts.print) {
    for (const n of toRemove) {
      const p = getPackage(db, n);
      if (p) console.log(t('would_remove', `${n}-${p.version}`));
    }
    return true;
  }

  if (!opts.nodeps && !opts.recursive && !opts.cascade) {
    if (isRequiredByOthers(name, new Set([name]), db)) {
      console.error(`error: failed to prepare transaction (could not satisfy dependencies)\n  :: ${name} is required by some other package`);
      console.error('  (use -Rdd to skip this check, or -Rs to remove orphans)');
      return false;
    }
  }

  console.log(t('checking_deps_remove') + '\n');
  console.log(`Packages (${toRemove.length}): ${toRemove.join('  ')}`);
  console.log('');

  if (!await confirm(':: Proceed with removal?', false)) return false;

  if (opts.recursive || opts.cascade) {
    const cols = process.stdout.columns || 80;
    for (let i = 0; i < toRemove.length; i++) {
      const n = toRemove[i];
      const p = getPackage(db, n);
      if (!p) continue;
      const bar = '#'.repeat(Math.max(Math.floor((cols - 45) * 0.35), 8));
      const ver = p.version;
      const pname = `${n}-${ver}`;
      process.stdout.write(`(${i + 1}/${toRemove.length}) removing ${pname.padEnd(Math.max(20, cols - 60))}${bar} 100%\n`);
      // Skip dep check — already verified in collectRemoveSet / removeByName
      removeSingle(n, { ...opts, recursive: false, cascade: false, nodeps: true });
    }
    console.log(t('pkg_removed', name));
    return true;
  }

  const cols = process.stdout.columns || 80;
  const bar = '#'.repeat(Math.max(Math.floor((cols - 45) * 0.35), 8));
  removeSingle(name, opts);
  process.stdout.write(t('progress_removing', '1', '1', name, bar) + '\n');
  console.log(t('pkg_removed', name));
  return true;
}
