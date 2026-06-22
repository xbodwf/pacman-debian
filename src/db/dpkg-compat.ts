import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { parseControlFile } from '../core/control';
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

export function writeDpkgEntry(pkg: InstalledPackage): void {
  if (!fs.existsSync(DPKG_STATUS)) return;

  const content = fs.readFileSync(DPKG_STATUS, 'utf8');
  const entries = content.split('\n\n').filter((e: string) => e.trim() !== '');
  let kept = entries.filter((e: string) => {
    const m = e.match(/^Package: (.+)$/m);
    return !(m && m[1] === pkg.name);
  });

  const entry = [
    `Package: ${pkg.name}`,
    `Status: install ok installed`,
    `Priority: ${pkg.controlPriority || 'optional'}`,
    `Section: ${pkg.controlSection || 'misc'}`,
    `Installed-Size: ${pkg.installedSize || 0}`,
    `Maintainer: ${pkg.maintainer || 'Unknown'}`,
    `Architecture: ${toDpkgArch(pkg.architecture)}`,
    `Version: ${pkg.version}`,
  ];

  if (pkg.depends) entry.push(`Depends: ${pkg.depends}`);
  entry.push(formatDescription(pkg.description));
  if (pkg.homepage) entry.push(`Homepage: ${pkg.homepage}`);

  kept = kept.filter((e: string) => e.trim() !== '');
  kept.push(entry.join('\n'));
  fs.writeFileSync(DPKG_STATUS, kept.join('\n\n') + '\n');
  _dpkgCache = null; // invalidate cache

  if (fs.existsSync(DPKG_INFO)) {
    const lp = `${DPKG_INFO}/${pkg.name}.list`;
    const files = pkg.files.length > 0
      ? pkg.files
      : (
          pkg.depends && /^[a-z]/.test(pkg.depends)
            ? loadFilesFromDpkg(pkg.depends.split(',')[0].trim().split(/\s/)[0])
            : []
        );
    const existing = fs.existsSync(lp)
      ? fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean)
      : [];
    fs.writeFileSync(lp, [...new Set([...existing, ...files])].sort().join('\n') + '\n');
  }
}

function loadFilesFromDpkg(name: string): string[] {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`dpkg -L ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function removeDpkgEntry(name: string): void {
  if (!fs.existsSync(DPKG_STATUS)) return;
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
}
