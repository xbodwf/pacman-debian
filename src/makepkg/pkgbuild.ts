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

/**
 * Source the PKGBUILD ONCE in a single bash invocation and extract all
 * variables + functions. Previously each variable/function required a
 * separate execSync (≈35 forks), which was very slow on low-end ARM boards.
 */
function bashParsePkgbuild(absPath: string): { scalars: Record<string, string>; arrays: Record<string, string[]>; funcs: Record<string, string> } {
  const script = [
    `source "${absPath}" 2>/dev/null`,
    'echo "S pkgbase=${pkgbase-unset}"',
    'echo "S pkgname=${pkgname-unset}"',
    'echo "S pkgver=${pkgver-unset}"',
    'echo "S pkgrel=${pkgrel-unset}"',
    'echo "S epoch=${epoch-unset}"',
    'echo "S pkgdesc=${pkgdesc-unset}"',
    'echo "S url=${url-unset}"',
    'echo "S install=${install-unset}"',
    'for i in "${arch[@]+"${arch[@]}"}"; do printf "A arch=%s\\n" "$i"; done',
    'for i in "${license[@]+"${license[@]}"}"; do printf "A license=%s\\n" "$i"; done',
    'for i in "${groups[@]+"${groups[@]}"}"; do printf "A groups=%s\\n" "$i"; done',
    'for i in "${depends[@]+"${depends[@]}"}"; do printf "A depends=%s\\n" "$i"; done',
    'for i in "${makedepends[@]+"${makedepends[@]}"}"; do printf "A makedepends=%s\\n" "$i"; done',
    'for i in "${optdepends[@]+"${optdepends[@]}"}"; do printf "A optdepends=%s\\n" "$i"; done',
    'for i in "${checkdepends[@]+"${checkdepends[@]}"}"; do printf "A checkdepends=%s\\n" "$i"; done',
    'for i in "${provides[@]+"${provides[@]}"}"; do printf "A provides=%s\\n" "$i"; done',
    'for i in "${conflicts[@]+"${conflicts[@]}"}"; do printf "A conflicts=%s\\n" "$i"; done',
    'for i in "${replaces[@]+"${replaces[@]}"}"; do printf "A replaces=%s\\n" "$i"; done',
    'for i in "${source[@]+"${source[@]}"}"; do printf "A source=%s\\n" "$i"; done',
    'for i in "${noextract[@]+"${noextract[@]}"}"; do printf "A noextract=%s\\n" "$i"; done',
    'for i in "${sha256sums[@]+"${sha256sums[@]}"}"; do printf "A sha256sums=%s\\n" "$i"; done',
    'for i in "${md5sums[@]+"${md5sums[@]}"}"; do printf "A md5sums=%s\\n" "$i"; done',
    'for i in "${validpgpkeys[@]+"${validpgpkeys[@]}"}"; do printf "A validpgpkeys=%s\\n" "$i"; done',
    'for i in "${options[@]+"${options[@]}"}"; do printf "A options=%s\\n" "$i"; done',
    'for i in "${backup[@]+"${backup[@]}"}"; do printf "A backup=%s\\n" "$i"; done',
    'for f in build package prepare check; do',
    '  echo "F $f"',
    '  declare -f "$f" 2>/dev/null || true',
    '  echo "E $f"',
    'done',
  ].join('\n');

  const out = execSync('bash -s', { input: script, encoding: 'utf8', timeout: 10000 }).trim();
  const lines = out.split('\n');

  const scalars: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};
  const funcs: Record<string, string> = {};

  let currentFunc: string | null = null;
  let funcBuffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith('S ')) {
      const val = line.substring(2);
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) {
        const value = val.substring(eqIdx + 1);
        if (value !== 'unset') scalars[val.substring(0, eqIdx)] = value;
      }
    } else if (line.startsWith('A ')) {
      const val = line.substring(2);
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) {
        const key = val.substring(0, eqIdx);
        const value = val.substring(eqIdx + 1);
        (arrays[key] || (arrays[key] = [])).push(value);
      }
    } else if (line.startsWith('F ')) {
      currentFunc = line.substring(2);
      funcBuffer = [];
    } else if (line.startsWith('E ') && currentFunc !== null && line.substring(2) === currentFunc) {
      if (funcBuffer.length > 0) funcs[currentFunc] = funcBuffer.join('\n');
      currentFunc = null;
      funcBuffer = [];
    } else if (currentFunc !== null) {
      funcBuffer.push(line);
    }
  }

  return { scalars, arrays, funcs };
}

export function parsePkgbuild(pkgbuildPath: string, _ignoreArch = false): PkgbuildInfo {
  if (!fs.existsSync(pkgbuildPath)) throw new Error(`PKGBUILD not found: ${pkgbuildPath}`);
  const absPath = path.resolve(pkgbuildPath);

  const { scalars, arrays, funcs } = bashParsePkgbuild(absPath);

  const info: PkgbuildInfo = {
    pkgbase: scalars['pkgbase'] || undefined,
    pkgname: scalars['pkgname'] || '',
    pkgver: scalars['pkgver'] || '',
    pkgrel: scalars['pkgrel'] || '',
    epoch: scalars['epoch'] || undefined,
    pkgdesc: scalars['pkgdesc'] || '',
    arch: arrays['arch'] || [],
    url: scalars['url'] || undefined,
    license: arrays['license'] || [],
    groups: arrays['groups'] || [],
    depends: arrays['depends'] || [],
    makedepends: arrays['makedepends'] || [],
    optdepends: arrays['optdepends'] || [],
    checkdepends: arrays['checkdepends'] || [],
    provides: arrays['provides'] || [],
    conflicts: arrays['conflicts'] || [],
    replaces: arrays['replaces'] || [],
    source: arrays['source'] || [],
    noextract: arrays['noextract'] || [],
    sha256sums: arrays['sha256sums'] || [],
    md5sums: arrays['md5sums'] || [],
    validpgpkeys: arrays['validpgpkeys'] || [],
    install: scalars['install'] || undefined,
    options: arrays['options'] || [],
    backup: arrays['backup'] || [],
    buildFn: funcs['build'] || '',
    packageFn: funcs['package'] || '',
    prepareFn: funcs['prepare'] || '',
    checkFn: funcs['check'] || '',
    validArch: true,
  };

  if (!info.pkgname) throw new Error('PKGBUILD missing pkgname');
  if (!info.pkgver) throw new Error('PKGBUILD missing pkgver');

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
