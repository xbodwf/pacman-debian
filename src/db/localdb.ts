import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstalledPackage } from '../core/types';

const LOCAL_DIR = '/var/lib/pacman-debian/local';
const BYNAME_DIR = path.join(LOCAL_DIR, 'by-name');
const FILE_INDEX = '/var/lib/pacman-debian/file-index.json';

function ensure(): void {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
  if (!fs.existsSync(BYNAME_DIR)) fs.mkdirSync(BYNAME_DIR, { recursive: true });
}

function pkgDir(pkg: InstalledPackage): string {
  return path.join(LOCAL_DIR, `${pkg.name}-${pkg.version}`);
}

function pkgDirFromName(name: string, version: string): string {
  return path.join(LOCAL_DIR, `${name}-${version}`);
}

function descPath(dir: string): string { return path.join(dir, 'desc'); }
function filesPath(dir: string): string { return path.join(dir, 'files'); }

/* ---- read / write ---- */

function writeDesc(pkg: InstalledPackage): void {
  fs.writeFileSync(descPath(pkgDir(pkg)), JSON.stringify({
    name: pkg.name, version: pkg.version, architecture: pkg.architecture,
    description: pkg.description, depends: pkg.depends,
    'pre-depends': pkg['pre-depends'], conflicts: pkg.conflicts,
    provides: pkg.provides, maintainer: pkg.maintainer, homepage: pkg.homepage,
    section: pkg.controlSection, priority: pkg.controlPriority,
    installedSize: pkg.installedSize, installTime: pkg.installTime,
    reason: pkg.reason, repoType: pkg.repoType,
  }));
}

function readDesc(dir: string): InstalledPackage | null {
  const fp = descPath(dir);
  if (!fs.existsSync(fp)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const files = readFiles(dir);
    return {
      name: d.name, version: d.version, architecture: d.architecture || 'amd64',
      description: d.description || '', depends: d.depends,
      'pre-depends': d['pre-depends'], conflicts: d.conflicts,
      provides: d.provides, maintainer: d.maintainer, homepage: d.homepage,
      controlSection: d.section, controlPriority: d.priority,
      installedSize: d.installedSize || 0, installTime: d.installTime || 0,
      reason: d.reason || 'explicit', files, repoType: d.repoType || 'debian',
    };
  } catch { return null; }
}

function writeFiles(pkg: InstalledPackage): void {
  fs.writeFileSync(filesPath(pkgDir(pkg)), JSON.stringify(pkg.files));
}

function readFiles(dir: string): string[] {
  const fp = filesPath(dir);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

/* ---- public API ---- */

export function addPackage(pkg: InstalledPackage): void {
  ensure();
  const dir = pkgDir(pkg);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeDesc(pkg);
  writeFiles(pkg);
  // Symlink by-name/<name> → ../<name>-<version>
  const link = path.join(BYNAME_DIR, pkg.name);
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(path.relative(BYNAME_DIR, dir), link);
  updateFileIndex(pkg.name, pkg.files);
}

export function removePackage(name: string, version?: string): void {
  ensure();
  // Find the dir
  const link = path.join(BYNAME_DIR, name);
  let dir: string | null = null;
  if (fs.existsSync(link)) try { dir = fs.readlinkSync(link); } catch {}
  if (!dir && version) {
    dir = pkgDirFromName(name, version);
    if (!fs.existsSync(dir)) dir = null;
  }
  if (!dir) {
    // Search local dir
    for (const entry of fs.readdirSync(LOCAL_DIR)) {
      if (entry.startsWith(name + '-')) { dir = path.join(LOCAL_DIR, entry); break; }
    }
  }
  if (dir && fs.existsSync(dir)) {
    const files = readFiles(dir);
    removeFileIndex(name, files);
    fs.rmSync(dir, { recursive: true });
  }
  try { fs.unlinkSync(link); } catch {}
}

export function listPackageNames(): string[] {
  ensure();
  const result: string[] = [];
  for (const entry of fs.readdirSync(LOCAL_DIR)) {
    if (entry === 'by-name') continue;
    if (entry.startsWith('.')) continue;
    const fp = path.join(LOCAL_DIR, entry, 'desc');
    if (fs.existsSync(fp)) result.push(entry);
  }
  return result;
}

export function getPackage(name: string): InstalledPackage | undefined {
  ensure();
  // Try by-name symlink first
  const link = path.join(BYNAME_DIR, name);
  if (fs.existsSync(link)) {
    try {
      const target = fs.readlinkSync(link);
      const dir = path.resolve(BYNAME_DIR, target);
      const pkg = readDesc(dir);
      if (pkg) return pkg;
    } catch {}
  }
  // Fallback: scan local dir
  for (const entry of fs.readdirSync(LOCAL_DIR)) {
    if (entry.startsWith(name + '-')) {
      const pkg = readDesc(path.join(LOCAL_DIR, entry));
      if (pkg) return pkg;
    }
  }
  return undefined;
}

export function getAllPackages(): InstalledPackage[] {
  ensure();
  const result: InstalledPackage[] = [];
  for (const entry of fs.readdirSync(LOCAL_DIR)) {
    if (entry === 'by-name' || entry.startsWith('.')) continue;
    const pkg = readDesc(path.join(LOCAL_DIR, entry));
    if (pkg) result.push(pkg);
  }
  return result;
}

/* ---- file index (for -Qo) ---- */
let _fileIndex: Record<string, string> | null = null;

function loadFileIndex(): Record<string, string> {
  if (_fileIndex) return _fileIndex;
  if (!fs.existsSync(FILE_INDEX)) { _fileIndex = {}; return _fileIndex; }
  try { _fileIndex = JSON.parse(fs.readFileSync(FILE_INDEX, 'utf8')); } catch { _fileIndex = {}; }
  return _fileIndex!;
}

function saveFileIndex(idx: Record<string, string>): void {
  fs.writeFileSync(FILE_INDEX, JSON.stringify(idx));
}

function updateFileIndex(pkgName: string, files: string[]): void {
  const idx = loadFileIndex();
  for (const f of files) idx[f] = pkgName;
  saveFileIndex(idx);
}

function removeFileIndex(pkgName: string, files: string[]): void {
  const idx = loadFileIndex();
  for (const f of files) delete idx[f];
  saveFileIndex(idx);
}

export function getFileOwner(filePath: string): string | undefined {
  return loadFileIndex()[filePath];
}

export function invalidateFileIndex(): void { _fileIndex = null; }
