import * as fs from 'node:fs';
import { findInRepo, findInRepoScoped, findProvides, findProvidesScoped, batchFindInRepo } from '../repo/repository';
import { loadDatabase } from '../db/database';
import { readDpkgStatus, dpkgHasPackage } from '../db/dpkg-compat';
import { readPaclinks } from './paclinks';
import type { RepoPkg } from './types';

export interface Dep {
  name: string;
  version?: string;
  operator?: string;
  arch?: string;
}

export interface DepResult {
  pkg: RepoPkg;
  needed: boolean;
  reason: string;
}

/* ---- Dependency string parser ---- */
export function parseDep(s: string): Dep[] {
  const alternatives = s.split('|').map(a => a.trim());
  return alternatives.map(a => {
    let name = a;
    let operator: string | undefined;
    let version: string | undefined;

    // Debian: "pkg (>= 1.0)" or Arch: "pkg>=1.0"
    const parenMatch = a.match(/\(?\s*([<>=!]+)\s*([^)]+)\s*\)?\s*$/);
    if (parenMatch) {
      operator = parenMatch[1].trim();
      version = parenMatch[2].trim().replace(/\)$/, '').trim();
      name = a.slice(0, a.indexOf(parenMatch[1])).trim();
      // Clean trailing paren/space from name
      name = name.replace(/\(\s*$/, '').trim();
    }

    // Architecture qualifier: "libc6:arm64"
    const archSep = name.lastIndexOf(':');
    let arch: string | undefined;
    if (archSep > 0 && name.length - archSep <= 8 && !name.includes('/')) {
      arch = name.slice(archSep + 1);
      name = name.slice(0, archSep);
    }

    return { name, version, operator, arch };
  });
}

/* ---- Pure dpkg version comparison (no execSync needed) ---- */
/* Ported from dpkg/lib/dpkg/version.c — verrevcmp + order */

function order(c: string): number {
  if (c >= '0' && c <= '9') return 0;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return c.charCodeAt(0);
  if (c === '~') return -1;
  if (c) return c.charCodeAt(0) + 256;
  return 0;
}

function verrevcmp(a: string, b: string): number {
  let ai = 0, bi = 0;
  while (ai < a.length || bi < b.length) {
    let firstDiff = 0;

    // Skip non-digit prefixes
    while ((ai < a.length && !(a[ai] >= '0' && a[ai] <= '9')) ||
           (bi < b.length && !(b[bi] >= '0' && b[bi] <= '9'))) {
      const ac = ai < a.length ? order(a[ai]) : 0;
      const bc = bi < b.length ? order(b[bi]) : 0;
      if (ac !== bc) return ac - bc;
      ai++;
      bi++;
    }

    // Skip leading zeros
    while (ai < a.length && a[ai] === '0') ai++;
    while (bi < b.length && b[bi] === '0') bi++;

    // Compare digit sequences
    while (ai < a.length && a[ai] >= '0' && a[ai] <= '9' &&
           bi < b.length && b[bi] >= '0' && b[bi] <= '9') {
      if (!firstDiff) firstDiff = a.charCodeAt(ai) - b.charCodeAt(bi);
      ai++;
      bi++;
    }

    if (ai < a.length && a[ai] >= '0' && a[ai] <= '9') return 1;
    if (bi < b.length && b[bi] >= '0' && b[bi] <= '9') return -1;
    if (firstDiff) return firstDiff;
  }

  return 0;
}

/** Parse "1:2.3-4" → { epoch: 1, version: "2.3", revision: "4" } */
function parseDpkgVersion(s: string): { epoch: number; version: string; revision: string } {
  let epoch = 0;
  let rest = s.trim();

  const colon = rest.indexOf(':');
  if (colon > 0) {
    const epochStr = rest.slice(0, colon);
    if (/^\d+$/.test(epochStr)) {
      epoch = parseInt(epochStr, 10);
      rest = rest.slice(colon + 1);
    }
  }

  const hyphen = rest.lastIndexOf('-');
  let version: string, revision: string;
  if (hyphen > 0) {
    version = rest.slice(0, hyphen);
    revision = rest.slice(hyphen + 1);
  } else {
    version = rest;
    revision = '';
  }

  return { epoch, version, revision };
}

/**
 * Compare two dpkg-style version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function verCmp(a: string, b: string): number {
  const va = parseDpkgVersion(a);
  const vb = parseDpkgVersion(b);

  if (va.epoch > vb.epoch) return 1;
  if (va.epoch < vb.epoch) return -1;

  const rc = verrevcmp(va.version, vb.version);
  if (rc) return rc;

  return verrevcmp(va.revision, vb.revision);
}

function checkVersion(installed: string, operator: string, required: string): boolean {
  const cmp = verCmp(installed, required);
  switch (operator) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=': case '==': return cmp === 0;
    default: return true; // no constraint
  }
}

/* ---- Fast path: pre-load DBs once ---- */
interface DepState {
  localPkgs: Map<string, string>;
  localHasFiles: Set<string>;
  localLinks: Set<string>;  // link packages (virtual -> deb mappings)
  dpkgPkgs: Map<string, string>;
  paclinkDebs: Map<string, string>;
  repoCache: RepoPkg[] | null;
}

// Packages that MUST come from dpkg - never install from Arch repos
const SYSTEM_PKGS = new Set([
  'glibc', 'libc6', 'linux-api-headers', 'filesystem', 'iana-etc',
  'bash', 'coreutils', 'systemd', 'dbus', 'util-linux', 'shadow',
  'pam', 'libcap', 'libseccomp', 'zlib', 'libzstd', 'libarchive',
]);

let _state: DepState | null = null;

function getState(): DepState {
  if (_state) return _state;
  const local = loadDatabase();
  const localMap = new Map<string, string>();
  const localHasFiles = new Set<string>();
  const localLinks = new Set<string>();
  for (const [n, p] of local.packages) {
    localMap.set(n, p.version);
    if (p.repoType === 'link') { localLinks.add(n); continue; }
    if (!p.files || p.files.length === 0) continue;
    for (const f of p.files) {
      // Skip pure directory entries - only count real files
      if (f.endsWith('/')) continue;
      try { if (fs.existsSync(f)) { localHasFiles.add(n); break; } } catch {}
    }
  }

  const dpkg = readDpkgStatus();
  const dpkgMap = new Map<string, string>();
  for (const [n, p] of dpkg) dpkgMap.set(n, p.version);
  const paclinkDebs = new Map(readPaclinks().map(link => [link.virt.toLowerCase(), link.deb]));

  _state = { localPkgs: localMap, localHasFiles, localLinks, dpkgPkgs: dpkgMap, paclinkDebs, repoCache: null };
  return _state;
}

/* ---- Check if dep is satisfied (optionally version-aware for upgrades) ---- */
function isDepSatisfied(dep: Dep, state: DepState, upgradeMode = false): boolean {
  // Check local pacman-debian DB first (with file existence verification)
  const localVer = state.localPkgs.get(dep.name);
  if (localVer) {
    // Link packages (virtual -> deb mappings): if a real repo package exists,
    // prefer the real package over the link.
    if (state.localLinks.has(dep.name)) {
      const rp = findInRepo(dep.name);
      if (rp) return false; // real package available — install it, don't use link
      // Check if the real deb package is installed via dpkg
      const local = loadDatabase();
      const linkPkg = local.packages.get(dep.name);
      if (linkPkg && linkPkg.depends) {
        const debName = linkPkg.depends.split(',')[0].trim().split(/\s/)[0];
        const debVer = state.dpkgPkgs.get(debName);
        if (debVer) {
          if (dep.operator && dep.version) return checkVersion(debVer, dep.operator, dep.version);
          return true;
        }
      }
      if (dep.operator && dep.version) return checkVersion(localVer, dep.operator, dep.version);
      return true;
    }
    if (!state.localHasFiles.has(dep.name)) return false;
    if (dep.operator && dep.version) return checkVersion(localVer, dep.operator, dep.version);
    if (upgradeMode) {
      const rp = findInRepo(dep.name);
      if (rp && rp.version !== localVer) return false;
    }
    return true;
  }
  // Fall back to dpkg
  const mappedDeb = state.paclinkDebs.get(dep.name.toLowerCase());
  const installedVer = state.dpkgPkgs.get(dep.name) || (mappedDeb ? state.dpkgPkgs.get(mappedDeb) : undefined);
  if (!installedVer) return false;
  if (dep.operator && dep.version) {
    return checkVersion(installedVer, dep.operator, dep.version);
  }
  // No version constraint — if upgradeMode, check repo for newer version
  if (upgradeMode) {
    const rp = findInRepo(dep.name);
    if (rp && rp.version !== installedVer) return false; // upgrade available
  }
  return true;
}

/* ---- Find provider in repo (uses cached idx + provides index) ---- */
function findProvider(name: string, state: DepState, preferredRepos: string[] = []): RepoPkg | undefined {
  for (const repo of preferredRepos) {
    const scoped = findInRepoScoped(repo, name);
    if (scoped) return scoped;
    const provided = findProvidesScoped(repo, name);
    if (provided) return provided;
  }
  // Direct lookup via cached idx (binary search, no disk I/O)
  const direct = findInRepo(name);
  if (direct) return direct;
  // Provides lookup via inverted index (O(1) instead of O(N))
  const provided = findProvides(name);
  if (provided) return provided;
  // Paclink: virtual name → resolve to real deb package name
  const local = loadDatabase();
  const linkPkg = local.packages.get(name);
  if (linkPkg && linkPkg.repoType === 'link' && linkPkg.depends) {
    const debName = linkPkg.depends.split(',')[0].trim().split(/\s/)[0];
    const debRp = findInRepo(debName);
    if (debRp) return debRp;
  }
  return undefined;
}

/* ---- Full dependency resolution ---- */
export interface ResolveDepsOptions {
  upgradeMode?: boolean;
  /** Repositories to try first for each target, keyed by package name. */
  preferredRepos?: Map<string, string[]>;
}

export function resolveDeps(targets: string[], opts: ResolveDepsOptions = {}): { install: DepResult[]; errors: string[] } {
  const state = getState();
  const install: DepResult[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const resolvedSet = new Set<string>();
  const queue: Array<{ name: string; preferredRepos: string[] }> = targets.map(name => {
    const slash = name.indexOf('/');
    const packageName = slash > 0 ? name.slice(slash + 1) : name;
    const configured = opts.preferredRepos?.get(packageName) || [];
    return { name: packageName, preferredRepos: slash > 0 ? [name.slice(0, slash), ...configured] : configured };
  });
  let processedCount = 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    const name = item.name;
    processedCount++;
    if (seen.has(name)) continue;
    seen.add(name);

    const satisfied = isDepSatisfied({ name }, state, opts.upgradeMode);

    // 已安装且是显式目标 → 仍要处理其依赖
    if (satisfied && processedCount > targets.length) continue;

    if (SYSTEM_PKGS.has(name)) {
      if (!state.dpkgPkgs.has(name))
        errors.push(`'${name}' is a system package not available via dpkg`);
      continue;
    }

    const rp = findProvider(name, state, item.preferredRepos);
    if (!rp) {
      errors.push(`'${name}' not found`);
      continue;
    }

    if (!resolvedSet.has(rp.package)) {
      resolvedSet.add(rp.package);
      const reason = opts.upgradeMode && state.localPkgs.has(rp.package) ? 'upgrade' : 'target';
      install.push({ pkg: rp, needed: true, reason });
    }

    for (const d of parseDepList(rp.depends)) {
      if (!seen.has(d.name) && !isDepSatisfied(d, state, opts.upgradeMode)) {
        queue.push({ name: d.name, preferredRepos: [rp.repo, ...item.preferredRepos.filter(r => r !== rp.repo)] });
      }
    }
  }

  // 排序：依赖在前，显式目标在后
  install.sort((a, b) => {
    const aIsTarget = targets.includes(a.pkg.package);
    const bIsTarget = targets.includes(b.pkg.package);
    if (aIsTarget && !bIsTarget) return 1;
    if (!aIsTarget && bIsTarget) return -1;
    return 0;
  });
  return { install, errors };
}

export function invalidateDepCache(): void { _state = null; }

function parseDepList(s?: string): Dep[] {
  if (!s) return [];
  const result: Dep[] = [];
  // Debian format: comma-separated (libc6 (>= 2.34), libyyjson)
  // Arch format: space-separated (glibc>=2.35  yyjson)
  const parts = s.includes(',') ? s.split(',') : (() => {
    // No comma: could be single Debian dep with parens like "libc6 (>= 2.34)"
    // or space-separated Arch deps like "glibc>=2.35  yyjson"
    // If the string has parens, treat as single dep (Debian style)
    if (s.includes('(') || s.includes(')')) return [s];
    return s.split(/\s+/);
  })();
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = parseDep(trimmed);
    if (parsed.length > 0) result.push(parsed[0]);
  }
  return result;
}

/* ---- Conflict detection ---- */
export interface Conflict {
  a: string;
  b: string;
  reason: string;
}

export function detectConflicts(packages: RepoPkg[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const names = new Set(packages.map(p => p.package));

  for (const pkg of packages) {
    const pkgConflicts = pkg.conflicts || '';
    const conflictNames = pkgConflicts.split(',').map(s => s.trim().split(/[<>=]/)[0].trim()).filter(Boolean);

    for (const c of conflictNames) {
      // Check against other to-be-installed packages
      for (const other of packages) {
        if (other.package !== pkg.package && other.package === c) {
          conflicts.push({ a: pkg.package, b: c, reason: `${pkg.package} conflicts with ${c}` });
        }
      }
      // Check against installed packages
      // A package may declare a self-conflict in Debian metadata (or inherit
      // one while replacing an older build). The incoming package replaces the
      // installed instance, so this is a normal upgrade, not a conflict.
      if (c !== pkg.package && (dpkgHasPackage(c) || loadDatabase().packages.has(c))) {
        conflicts.push({ a: pkg.package, b: c, reason: `${pkg.package} conflicts with installed ${c}` });
      }
    }
  }

  return conflicts;
}
