import * as zlib from 'node:zlib';
import { iterateTar } from './tar';

export interface PkgInfo {
  name: string;
  version: string;
  base?: string;
  description?: string;
  depends?: string[];
  conflicts?: string[];
  provides?: string[];
  url?: string;
  license?: string[];
  arch?: string;
  installedSize?: number;
  size?: number;
  packager?: string;
  buildDate?: number;
}

export interface InstallScript {
  pre_install?: string;
  post_install?: string;
  pre_remove?: string;
  post_remove?: string;
}

function parsePKGINFO(content: string): PkgInfo {
  const info: PkgInfo = { name: '', version: '' };
  const deps: string[] = [];
  const conflicts: string[] = [];
  const provides: string[] = [];
  const licenses: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf(' = ');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 3).trim();

    switch (key) {
      case 'pkgname': info.name = val; break;
      case 'pkgbase': info.base = val; break;
      case 'pkgver': info.version = val; break;
      case 'pkgdesc': info.description = val; break;
      case 'url': info.url = val; break;
      case 'arch': info.arch = val; break;
      case 'packager': info.packager = val; break;
      case 'builddate': info.buildDate = parseInt(val, 10) || undefined; break;
      case 'size': info.size = parseInt(val, 10) || undefined; break;
      case 'installed_size': info.installedSize = parseInt(val, 10) || undefined; break;
      case 'depend': deps.push(val.split(/[<>=]/)[0].trim()); break;
      case 'conflict': conflicts.push(val.split(/[<>=]/)[0].trim()); break;
      case 'provides': provides.push(val.split(/[<>=]/)[0].trim()); break;
      case 'license': licenses.push(val); break;
    }
  }

  if (deps.length > 0) info.depends = deps;
  if (conflicts.length > 0) info.conflicts = conflicts;
  if (provides.length > 0) info.provides = provides;
  if (licenses.length > 0) info.license = licenses;
  return info;
}

function parseInstallScript(content: string): InstallScript {
  const script: InstallScript = {};
  const funcs = ['pre_install', 'post_install', 'pre_remove', 'post_remove'];
  for (const fn of funcs) {
    const re = new RegExp(`${fn}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
    const m = content.match(re);
    if (m) (script as any)[fn] = m[1].trim();
  }
  return script;
}

export function parsePkgTarZst(data: Buffer): { info: PkgInfo; install?: InstallScript; files: string[]; dataBlocks: { name: string; data: Buffer | null }[] } {
  // decompress zstd
  const { execSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archpkg-'));
  const inFile = path.join(tmp, 'input.zst');
  const outFile = path.join(tmp, 'output.tar');
  try {
    fs.writeFileSync(inFile, data);
    execSync(`zstd -d -f "${inFile}" --stdout > "${outFile}"`, { stdio: 'pipe' });
    const tarData = fs.readFileSync(outFile);
    return parseArchTar(tarData);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
    try { fs.rmdirSync(tmp); } catch {}
  }
}

function parseArchTar(tarData: Buffer): { info: PkgInfo; install?: InstallScript; files: string[]; dataBlocks: { name: string; data: Buffer | null }[] } {
  let info: PkgInfo = { name: '', version: '' };
  let install: InstallScript | undefined;
  const files: string[] = [];
  const dataBlocks: { name: string; data: Buffer | null }[] = [];

  for (const entry of iterateTar(tarData)) {
    const name = entry.name.replace(/^\.\//, '');
    if (name === '.PKGINFO' && entry.data) {
      info = parsePKGINFO(entry.data.toString('utf8'));
      continue;
    }
    if (name === '.INSTALL' && entry.data) {
      install = parseInstallScript(entry.data.toString('utf8'));
      continue;
    }
    if (name === '.MTREE' || name === '' || name.startsWith('.')) continue;
    files.push('/' + name);
    dataBlocks.push({ name, data: entry.data });
  }

  return { info, install, files, dataBlocks };
}

export function extractArchTarEntry(name: string, dest: string, entries: { name: string; data: Buffer | null }[]): void {
  const entry = entries.find(e => e.name === name);
  if (!entry || !entry.data) return;
  const targetPath = require('node:path').resolve(dest, name);
  require('node:fs').mkdirSync(require('node:path').dirname(targetPath), { recursive: true });
  require('node:fs').writeFileSync(targetPath, entry.data, { mode: 0o755 });
}

export function parseDescFile(content: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let currentKey = '';
  const values: string[] = [];

  for (const line of content.split('\n')) {
    const keyMatch = line.match(/^%([A-Z_]+)%$/);
    if (keyMatch) {
      if (currentKey && values.length > 0) result[currentKey] = [...values];
      currentKey = keyMatch[1].toLowerCase();
      values.length = 0;
    } else if (line.trim()) {
      values.push(line.trim());
    }
  }
  if (currentKey && values.length > 0) result[currentKey] = [...values];

  return result;
}
