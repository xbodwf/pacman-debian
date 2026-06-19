import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PkgbuildInfo {
  pkgbase?: string;
  pkgname: string;
  pkgver: string;
  pkgrel: string;
  epoch?: string;
  pkgdesc: string;
  arch: string[];
  url?: string;
  license: string[];
  groups: string[];
  depends: string[];
  makedepends: string[];
  optdepends: string[];
  checkdepends: string[];
  provides: string[];
  conflicts: string[];
  replaces: string[];
  source: string[];
  noextract: string[];
  sha256sums: string[];
  md5sums: string[];
  validpgpkeys: string[];
  install?: string;
  options: string[];
  backup: string[];
  buildFn: string;
  packageFn: string;
  prepareFn: string;
  checkFn: string;
  validArch: boolean;
}

function bashGet(v: string, p: string): string {
  try {
    return execSync(
      `bash -c 'source "${p}" 2>/dev/null; printf "%s" "${'$'}{${v}}" 2>/dev/null'`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
  } catch { return ''; }
}

function bashGetArray(v: string, p: string): string[] {
  try {
    const out = execSync(
      `bash -c 'source "${p}" 2>/dev/null; for i in "${'$'}{${v}[@]}"; do echo "$i"; done' 2>/dev/null`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

function bashGetFn(f: string, p: string): string {
  try {
    return execSync(
      `bash -c 'source "${p}" 2>/dev/null; declare -f ${f} 2>/dev/null'`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
  } catch { return ''; }
}

export function parsePkgbuild(pkgbuildPath: string, ignoreArch = false): PkgbuildInfo {
  if (!fs.existsSync(pkgbuildPath)) throw new Error(`PKGBUILD not found: ${pkgbuildPath}`);
  const absPath = path.resolve(pkgbuildPath);

  const arch = bashGetArray('arch', absPath);
  const systemArch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const validArch = ignoreArch || arch.length === 0 || arch.includes('any') || arch.includes(systemArch);

  const info: PkgbuildInfo = {
    pkgbase: bashGet('pkgbase', absPath) || undefined,
    pkgname: bashGet('pkgname', absPath),
    pkgver: bashGet('pkgver', absPath),
    pkgrel: bashGet('pkgrel', absPath),
    epoch: bashGet('epoch', absPath) || undefined,
    pkgdesc: bashGet('pkgdesc', absPath) || '',
    arch,
    url: bashGet('url', absPath) || undefined,
    license: bashGetArray('license', absPath),
    groups: bashGetArray('groups', absPath),
    depends: bashGetArray('depends', absPath),
    makedepends: bashGetArray('makedepends', absPath),
    optdepends: bashGetArray('optdepends', absPath),
    checkdepends: bashGetArray('checkdepends', absPath),
    provides: bashGetArray('provides', absPath),
    conflicts: bashGetArray('conflicts', absPath),
    replaces: bashGetArray('replaces', absPath),
    source: bashGetArray('source', absPath),
    noextract: bashGetArray('noextract', absPath),
    sha256sums: bashGetArray('sha256sums', absPath),
    md5sums: bashGetArray('md5sums', absPath),
    validpgpkeys: bashGetArray('validpgpkeys', absPath),
    install: bashGet('install', absPath) || undefined,
    options: bashGetArray('options', absPath),
    backup: bashGetArray('backup', absPath),
    buildFn: bashGetFn('build', absPath),
    packageFn: bashGetFn('package', absPath),
    prepareFn: bashGetFn('prepare', absPath),
    checkFn: bashGetFn('check', absPath),
    validArch,
  };

  if (!info.pkgname) throw new Error('PKGBUILD missing pkgname');
  if (!info.pkgver) throw new Error('PKGBUILD missing pkgver');
  if (!info.validArch) throw new Error(`PKGBUILD does not support architecture: ${systemArch} (${arch.join(', ')})`);

  return info;
}

export function pkgFilename(info: PkgbuildInfo, archOverride?: string): string {
  return `${info.pkgname}-${info.pkgver}-${info.pkgrel}-${archOverride || info.arch[0] || 'any'}.pkg.tar.zst`;
}

export function printSrcinfo(info: PkgbuildInfo): string {
  const lines: string[] = [
    `pkgbase = ${info.pkgbase || info.pkgname}`,
    `pkgname = ${info.pkgname}`,
    `pkgver = ${info.pkgver}`,
    `pkgrel = ${info.pkgrel}`,
  ];
  if (info.epoch) lines.push(`epoch = ${info.epoch}`);
  lines.push(`pkgdesc = ${info.pkgdesc}`);
  for (const a of info.arch) lines.push(`arch = ${a}`);
  if (info.url) lines.push(`url = ${info.url}`);
  for (const l of info.license) lines.push(`license = ${l}`);
  for (const g of info.groups) lines.push(`group = ${g}`);
  for (const d of info.depends) lines.push(`depend = ${d}`);
  for (const d of info.makedepends) lines.push(`makedepend = ${d}`);
  for (const d of info.optdepends) lines.push(`optdepend = ${d}`);
  for (const d of info.checkdepends) lines.push(`checkdepend = ${d}`);
  for (const p of info.provides) lines.push(`provides = ${p}`);
  for (const c of info.conflicts) lines.push(`conflict = ${c}`);
  for (const r of info.replaces) lines.push(`replaces = ${r}`);
  for (const s of info.source) lines.push(`source = ${s}`);
  for (const s of info.noextract) lines.push(`noextract = ${s}`);
  for (const s of info.sha256sums) lines.push(`sha256sums = ${s}`);
  for (const s of info.md5sums) lines.push(`md5sums = ${s}`);
  if (info.install) lines.push(`install = ${info.install}`);
  for (const o of info.options) lines.push(`options = ${o}`);
  for (const b of info.backup) lines.push(`backup = ${b}`);
  return lines.join('\n') + '\n';
}
