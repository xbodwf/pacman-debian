import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { parseControlFile } from '../core/control';
import { readPaclinks } from '../core/paclinks';
import { acquireDpkgLock, releaseDpkgLock } from '../lock/dpkg-lock';
import type { InstalledPackage } from '../core/types';

const DPKG_STATUS = '/var/lib/dpkg/status';
const DPKG_INFO = '/var/lib/dpkg/info';

export interface DpkgEntry {
  package: string;
  version: string;
  architecture: string;
  status: string;
  description?: string;
  maintainer?: string;
  depends?: string;
  installedSize?: number;
  section?: string;
  priority?: string;
  homepage?: string;
}

/* ---- In-memory cache with mtime check ---- */
let _dpkgCache: { mtime: number; data: Map<string, DpkgEntry> } | null = null;

export function readDpkgStatus(): Map<string, DpkgEntry> {
  if (!fs.existsSync(DPKG_STATUS)) return new Map();
  try {
    const st = fs.statSync(DPKG_STATUS);
    if (_dpkgCache && _dpkgCache.mtime === st.mtimeMs) return _dpkgCache.data;
  } catch {}

  const content = fs.readFileSync(DPKG_STATUS, 'utf8');
  const result = new Map<string, DpkgEntry>();
  for (const entry of content.split('\n\n').filter(Boolean)) {
    const fields = parseControlFile(entry);
    const name = fields['package'];
    if (!name) continue;
    const status = (fields['status'] || '').trim();
    if (!status.startsWith('install ok installed')) continue;
    result.set(name, {
      package: name, version: fields['version'] || '',
      architecture: fields['architecture'] || '', status,
      description: fields['description']?.split('\n')[0],
      maintainer: fields['maintainer'], depends: fields['depends'],
      installedSize: fields['installed-size'] ? parseInt(fields['installed-size'], 10) : undefined,
      section: fields['section'], priority: fields['priority'], homepage: fields['homepage'],
    });
  }
  _dpkgCache = { mtime: fs.statSync(DPKG_STATUS).mtimeMs, data: result };
  return result;
}

export function dpkgHasPackage(name: string): boolean {
  return readDpkgStatus().has(name);
}

const ARCH_MAP: Record<string, string> = {
  aarch64: 'arm64', x86_64: 'amd64', i686: 'i386',
  armv7h: 'armhf', armv6h: 'armhf', riscv64: 'riscv64',
};

function toDpkgArch(arch: string): string {
  return ARCH_MAP[arch] || arch;
}

function formatDescription(desc?: string): string {
  if (!desc || desc.trim() === '') return 'Description: ';
  const lines = desc.split('\n');
  if (lines.length <= 1) return `Description: ${desc}`;
  const first = lines[0];
  const rest = lines.slice(1).map(l => ' ' + l).join('\n');
  return `Description: ${first}\n${rest}`;
}

export async function writeDpkgEntry(pkg: InstalledPackage): Promise<void> {
  if (!fs.existsSync(DPKG_STATUS)) return;
  await acquireDpkgLock();
  try {

  // Skip packages whose architecture doesn't match the system — they'd cause
  // multiarch conflicts in dpkg (e.g. lib32-*:amd64 on aarch64).
  const pkgArch = toDpkgArch(pkg.architecture);
  const sysArch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const sysDpkgArch = toDpkgArch(sysArch);
  const archMismatch = pkgArch !== sysDpkgArch;

  const content = fs.readFileSync(DPKG_STATUS, 'utf8');
  const entries = content.split('\n\n').filter((e: string) => e.trim() !== '');
  let kept = entries.filter((e: string) => {
    const m = e.match(/^Package: (.+)$/m);
    return !(m && m[1] === pkg.name);
  });

  // Strip :arch qualifiers from deps when package arch doesn't match system
  // (otherwise dpkg would try to resolve libfreetype6:amd64 on aarch64)
  let translateDep: (d: string) => string;
  {
    const paclinks = readPaclinks();
    const virtMap = new Map(paclinks.map(e => [e.virt.toLowerCase(), e.deb]));
    const debSet = new Set(paclinks.map(e => e.deb.toLowerCase()));
    translateDep = (dep: string): string => {
      const trimmed = dep.trim();
      const noArch = archMismatch ? trimmed.replace(/:[\w.]+/g, '') : trimmed;
      const name = noArch.split(/[<>=]/)[0].trim().toLowerCase();

      // Drop deps with wrong arch
      if (!archMismatch) {
        const a = trimmed.match(/:([\w.]+)$/);
        if (a && a[1] !== sysDpkgArch) return '';
      }

      const mapped = virtMap.get(name);
      if (mapped) return noArch.replace(/^[^<>=]+/, mapped);
      if (debSet.has(name)) return noArch;
      if (name.endsWith('.so') || /^lib/.test(name) || name.endsWith('common') || name === 'sh') return '';
      return noArch;
    };
  }

  let depends = '';
  if (pkg.depends) {
    depends = pkg.depends.split(',').map(d => translateDep(d.trim())).filter(Boolean).join(', ');
  }

  const entry = [
    `Package: ${pkg.name}`,
    `Status: install ok installed`,
    `Priority: ${pkg.controlPriority || 'optional'}`,
    `Section: ${pkg.controlSection || 'misc'}`,
    `Installed-Size: ${pkg.installedSize || 0}`,
    `Maintainer: ${pkg.maintainer || 'Unknown'}`,
    `Architecture: ${archMismatch ? sysDpkgArch : pkgArch}`,
    `Version: ${pkg.version}`,
  ];

  if (depends) entry.push(`Depends: ${depends}`);
  if (pkg.license) entry.push(`License: ${pkg.license}`);
  if (pkg.pkgbase) entry.push(`X-Pacman-Base: ${pkg.pkgbase}`);
  if (pkg.buildDate) entry.push(`X-Pacman-Build-Date: ${pkg.buildDate}`);
  entry.push(formatDescription(pkg.description));
  if (pkg.homepage) entry.push(`Homepage: ${pkg.homepage}`);

  kept = kept.filter((e: string) => e.trim() !== '');
  kept.push(entry.join('\n'));
  fs.writeFileSync(DPKG_STATUS, kept.join('\n\n') + '\n');
  _dpkgCache = null; // invalidate cache

  if (fs.existsSync(DPKG_INFO)) {
    const lp = `${DPKG_INFO}/${pkg.name}.list`;
    const files = pkg.files.length > 0
      ? pkg.files.filter(f => f && f.trim())
      : (
          pkg.depends && /^[a-z]/.test(pkg.depends)
            ? loadFilesFromDpkg(pkg.depends.split(',')[0].trim().split(/\s/)[0])
            : []
        );
    const existing = fs.existsSync(lp)
      ? fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean)
      : [];
    const merged = [...new Set([...existing, ...files])].sort();
    if (merged.length > 0) {
      fs.writeFileSync(lp, merged.join('\n') + '\n');
    } else if (fs.existsSync(lp)) {
      fs.unlinkSync(lp);
    }
  }
  } finally { releaseDpkgLock(); }
}

function loadFilesFromDpkg(name: string): string[] {
  const listFile = `/var/lib/dpkg/info/${name}.list`;
  try {
    if (fs.existsSync(listFile)) {
      return fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
    }
  } catch {}
  return [];
}

export async function removeDpkgEntry(name: string): Promise<void> {
  if (!fs.existsSync(DPKG_STATUS)) return;
  await acquireDpkgLock();
  try {
  const content = fs.readFileSync(DPKG_STATUS, 'utf8');
  const entries = content.split('\n\n').filter((e: string) => e.trim() !== '');
  const kept = entries.filter((e: string) => {
    const m = e.match(/^Package: (.+)$/m);
    if (m && m[1] === name) return false;
    return true;
  });
  fs.writeFileSync(DPKG_STATUS, kept.join('\n\n') + '\n');
  _dpkgCache = null;

  const lp = `${DPKG_INFO}/${name}.list`;
  if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } finally { releaseDpkgLock(); }
}

/** Rewrite dpkg entries for all pacman-debian-managed Arch packages,
 *  translating dependency names through paclinks so apt doesn't break. */
export async function rewriteArchDpkgEntries(): Promise<void> {
  const { getAllPackages } = require('./localdb');
  const pkgs: InstalledPackage[] = getAllPackages().filter((p: InstalledPackage) => p.repoType === 'arch');
  for (const p of pkgs) {
    await writeDpkgEntry(p);
  }
}
