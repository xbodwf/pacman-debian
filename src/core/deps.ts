import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { findInRepo, findProvides, batchFindInRepo } from '../repo/repository';
import { loadDatabase } from '../db/database';
import { readDpkgStatus, dpkgHasPackage } from '../db/dpkg-compat';
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

/* ---- Version comparison ---- */
function verCmp(a: string, b: string): number {
  // Try dpkg compare first
  try {
    const out = execSync(`dpkg --compare-versions "${a}" gt "${b}" 2>/dev/null && echo gt || (dpkg --compare-versions "${a}" eq "${b}" 2>/dev/null && echo eq) || echo lt`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (out === 'gt') return 1;
    if (out === 'eq') return 0;
    if (out === 'lt') return -1;
  } catch {}

  // Fallback: simple numeric/string comparison
  const aParts = a.replace(/[^\d.]/g, '').split('.').map(Number);
  const bParts = b.replace(/[^\d.]/g, '').split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const an = aParts[i] || 0, bn = bParts[i] || 0;
    if (an !== bn) return an - bn;
  }
  return a.localeCompare(b);
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
  localHasFiles: Set<string>;  // packages that have at least one file on disk
  dpkgPkgs: Map<string, string>;
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
  for (const [n, p] of local.packages) {
    localMap.set(n, p.version);
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

  _state = { localPkgs: localMap, localHasFiles, dpkgPkgs: dpkgMap, repoCache: null };
  return _state;
}

/* ---- Check if dep is satisfied (optionally version-aware for upgrades) ---- */
function isDepSatisfied(dep: Dep, state: DepState, upgradeMode = false): boolean {
  // Check local pacman-debian DB first (with file existence verification)
  const localVer = state.localPkgs.get(dep.name);
  if (localVer) {
    if (!state.localHasFiles.has(dep.name)) return false;
    if (dep.operator && dep.version) return checkVersion(localVer, dep.operator, dep.version);
    if (upgradeMode) {
      const rp = findInRepo(dep.name);
      if (rp && rp.version !== localVer) return false;
    }
    return true;
  }
  // Fall back to dpkg
  const installedVer = state.dpkgPkgs.get(dep.name);
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
function findProvider(name: string, _state: DepState): RepoPkg | undefined {
  // Direct lookup via cached idx (binary search, no disk I/O)
  const direct = findInRepo(name);
  if (direct) return direct;
  // Provides lookup via inverted index (O(1) instead of O(N))
  return findProvides(name);
}

/* ---- Full dependency resolution ---- */
export interface ResolveDepsOptions {
  upgradeMode?: boolean;
}

export function resolveDeps(targets: string[], opts: ResolveDepsOptions = {}): { install: DepResult[]; errors: string[] } {
  const state = getState();
  const install: DepResult[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const resolvedSet = new Set<string>();
  const queue: string[] = [...targets];
  let processedCount = 0;

  while (queue.length > 0) {
    const name = queue.shift()!;
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

    const rp = findProvider(name, state);
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
        queue.push(d.name);
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
      if (dpkgHasPackage(c) || loadDatabase().packages.has(c)) {
        conflicts.push({ a: pkg.package, b: c, reason: `${pkg.package} conflicts with installed ${c}` });
      }
    }
  }

  return conflicts;
}
