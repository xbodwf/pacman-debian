import { execSync } from 'node:child_process';
import { findInRepo, getRepoCache } from '../repo/repository';
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
  for (const [n, p] of local.packages) localMap.set(n, p.version);

  const dpkg = readDpkgStatus();
  const dpkgMap = new Map<string, string>();
  for (const [n, p] of dpkg) dpkgMap.set(n, p.version);

  _state = { localPkgs: localMap, dpkgPkgs: dpkgMap, repoCache: null };
  return _state;
}

/* ---- Check if dep is satisfied ---- */
function isDepSatisfied(dep: Dep, state: DepState): boolean {
  const installedVer = state.localPkgs.get(dep.name) || state.dpkgPkgs.get(dep.name);
  if (!installedVer) return false;
  if (dep.operator && dep.version) {
    return checkVersion(installedVer, dep.operator, dep.version);
  }
  return true;
}

/* ---- Find provider in repo ---- */
function findProvider(name: string, state: DepState): RepoPkg | undefined {
  const direct = findInRepo(name);
  if (direct) return direct;

  // Search provides via packages.idx (index has provides field)
  const { loadConfig } = require('../repo/config');
  const { readPkgAt } = require('../repo/repository');
  const fs = require('node:fs');
  const path = require('node:path');

  const cfg = loadConfig();
  const PKG_CACHE = '/var/cache/pacman-debian/packages';
  for (const repo of cfg.repos) {
    const pkgDir = path.join(PKG_CACHE, repo.name);
    const idxPath = path.join(pkgDir, 'packages.idx');
    if (!fs.existsSync(idxPath)) continue;
    const idx = fs.readFileSync(idxPath, 'utf8').split('\n');
    for (const line of idx) {
      if (!line) continue;
      // idx: pkgname desc\tprovides\tchunkFile\toffset
      const firstTab = line.indexOf('\t');
      if (firstTab < 0) continue;
      const rest = line.slice(firstTab + 1);
      const secondTab = rest.indexOf('\t');
      if (secondTab < 0) continue;
      const provides = rest.slice(0, secondTab);
      if (!provides) continue;
      if (provides.split(',').some((pr: string) => {
        const pn = pr.trim().split(/[<>=]/)[0].trim();
        return pn === name;
      })) {
        const lastTab = line.lastIndexOf('\t');
        const byteOff = parseInt(line.slice(lastTab + 1), 10);
        const beforeOff = line.slice(0, lastTab);
        const thirdLastTab = beforeOff.lastIndexOf('\t');
        const chunkFile = beforeOff.slice(thirdLastTab + 1);
        if (chunkFile && !isNaN(byteOff)) {
          return readPkgAt(pkgDir, chunkFile, byteOff);
        }
      }
    }
  }
  return undefined;
}

/* ---- Full dependency resolution ---- */
export function resolveDeps(targets: string[]): { install: DepResult[]; errors: string[] } {
  const state = getState();
  const install: DepResult[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const toProcess: string[] = [...targets];

  while (toProcess.length > 0) {
    const name = toProcess.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);

    if (isDepSatisfied({ name }, state)) continue;

    // System packages must come from dpkg - skip Arch versions
    if (SYSTEM_PKGS.has(name)) {
      if (!state.dpkgPkgs.has(name)) {
        errors.push(`'${name}' is a system package not available via dpkg`);
      }
      continue;
    }

    const rp = findProvider(name, state);
    if (!rp) {
      errors.push(`'${name}' not found`);
      continue;
    }

    const alreadyResolved = install.some(i => i.pkg.package === rp.package);
    if (!alreadyResolved) {
      install.push({ pkg: rp, needed: true, reason: 'target' });
    }

    const deps = parseDepList(rp.depends);
    for (const d of deps) {
      if (!seen.has(d.name) && !isDepSatisfied(d, state)) {
        toProcess.push(d.name);
      }
    }
  }

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
