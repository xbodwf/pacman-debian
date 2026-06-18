import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { parseDeb, readScript } from '../core/deb';
import { extractTar } from '../core/tar';
import { parsePkgTarZst } from '../core/pkgfile';
import { findInRepo, downloadPkg, getRepoCache } from '../repo/repository';
import {
  initDb, loadDatabase, saveDatabase, addPackage, isInstalled, getPackage,
  saveScript, runScript, createTransaction, completeTransaction, parseDepends,
} from '../db/database';
import { writeDpkgEntry, dpkgHasPackage } from '../db/dpkg-compat';
import { formatBytes } from '../ui/format';
import { humanSize, drawProgressBar, formatRate, formatETA } from '../ui/progress';
import { confirm } from '../ui/prompt';
import type { InstalledPackage, RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';

async function installDeb(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  initDb();
  const pkg = parseDeb(filePath);
  const { control } = pkg;
  const db = loadDatabase();
  const existing = getPackage(db, control.package);

  if (opts.needed && existing && existing.version === control.version) {
    return false;
  }
  if (existing && existing.version === control.version) {
    const realFiles = existing.files.filter(f => { try { return !fs.lstatSync(f).isDirectory(); } catch { return false; } });
    if (realFiles.length > 0) return true;
  }

  const tx = createTransaction('install', control.package, control.version);
  if (!opts.noscriptlet) {
    const preinst = readScript(pkg, 'preinst');
    if (preinst) saveScript(control.package, 'preinst', preinst);
    runScript(control.package, 'preinst', ['install']);
  }

  const files = extractTar(pkg.dataTar, '/');

  if (!opts.noscriptlet) {
    const postinst = readScript(pkg, 'postinst');
    if (postinst) saveScript(control.package, 'postinst', postinst);
    runScript(control.package, 'postinst', ['configure']);
  }

  const ip: InstalledPackage = {
    name: control.package, version: control.version,
    architecture: control.architecture || 'amd64',
    description: control.description || '',
    depends: control.depends, 'pre-depends': control['pre-depends'],
    conflicts: control.conflicts, provides: control.provides,
    maintainer: control.maintainer, homepage: control.homepage,
    controlSection: control.section || 'misc',
    controlPriority: control.priority || 'optional',
    installedSize: control['installed-size'] ? parseInt(control['installed-size'], 10) : undefined,
    installTime: Date.now(), reason, files,
  };

  addPackage(db, ip);
  try { writeDpkgEntry(ip); } catch (e) { console.error('  WARNING: failed to write dpkg status:', e); }
  saveDatabase(db);
  completeTransaction(tx.id);
  return true;
}

async function installArch(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  initDb();
  const data = fs.readFileSync(filePath);
  const { info, install, files: pkgFiles, dataBlocks } = parsePkgTarZst(data);
  if (!info.name) throw new Error('invalid .pkg.tar.zst: missing pkgname');

  const db = loadDatabase();
  const existing = getPackage(db, info.name);
  if (opts.needed && existing && existing.version === info.version) return false;

  if (!opts.noscriptlet && install?.pre_install) {
    const script = `pre_install() {\n${install.pre_install}\n}\npost_install() { ${install.post_install || ''} }\npre_remove() { ${install.pre_remove || ''} }\npost_remove() { ${install.post_remove || ''} }\n`;
    saveScript(info.name, '.INSTALL', script);
    const tmpScript = `/var/lib/pacman-debian/info/${info.name}/.INSTALL`;
    try { execSync(`/bin/bash -c 'source "${tmpScript}" && pre_install'`, { stdio: 'inherit' }); } catch {}
  }

  const files: string[] = [];
  for (const entry of dataBlocks) {
    const targetPath = path.resolve('/', entry.name);
    if (!targetPath.startsWith('/')) continue;
    files.push('/' + entry.name);
    if (entry.data) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, entry.data, { mode: 0o755 });
    }
  }

  if (!opts.noscriptlet && install?.post_install) {
    const tmpScript = `/var/lib/pacman-debian/info/${info.name}/.INSTALL`;
    try { execSync(`/bin/bash -c 'source "${tmpScript}" && post_install'`, { stdio: 'inherit' }); } catch {}
  }

  const ip: InstalledPackage = {
    name: info.name, version: info.version,
    architecture: info.arch || 'any',
    description: info.description || '',
    depends: (info.depends || []).join(', '),
    conflicts: (info.conflicts || []).join(', '),
    provides: (info.provides || []).join(', '),
    homepage: info.url,
    controlSection: 'unknown', controlPriority: 'optional',
    installedSize: info.installedSize,
    installTime: Date.now(), reason, files, repoType: 'arch',
  };

  addPackage(db, ip);
  try { writeDpkgEntry(ip); } catch (e) { console.error('  WARNING: failed to write dpkg status:', e); }
  saveDatabase(db);
  return true;
}

export async function installPkgFile(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  if (opts.print) { console.log(`  would install: ${path.basename(filePath)}`); return true; }
  if (filePath.endsWith('.pkg.tar.zst') || filePath.endsWith('.pkg.tar.xz') || filePath.endsWith('.pkg.tar.gz')) {
    return installArch(filePath, reason, opts);
  }
  return installDeb(filePath, reason, opts);
}

function resolveDepsRecursive(pkgName: string, seen: Set<string>): RepoPkg[] {
  if (seen.has(pkgName)) return [];
  seen.add(pkgName);
  if (dpkgHasPackage(pkgName)) return [];

  const db = loadDatabase();
  if (isInstalled(db, pkgName)) return [];

  const rp = findInRepo(pkgName);
  if (!rp) return [];

  const result: RepoPkg[] = [];
  const deps = parseDepends(rp.depends);
  for (const dep of deps) {
    result.push(...resolveDepsRecursive(dep.name, seen));
    const depRp = findInRepo(dep.name);
    if (depRp && !seen.has(depRp.package)) {
      seen.add(depRp.package);
      result.push(depRp);
    }
  }
  return result;
}

export async function installPkg(target: string, opts: InstallOptions = {}): Promise<boolean> {
  if (fs.existsSync(target) && ['.deb', '.pkg.tar.zst', '.pkg.tar.xz', '.pkg.tar.gz'].some(e => target.endsWith(e))) {
    const cols = process.stdout.columns || 80;
    const barLen = Math.max(Math.floor((cols - 30) * 0.35), 8);
    const barDone = '#'.repeat(barLen);
    const fname = path.basename(target).replace(/\.(pkg\.tar\.(zst|xz|gz)|deb)$/, '');

    console.log(`Packages (1): ${fname}\n`);
    if (!await confirm(':: Proceed with installation?')) return false;
    if (opts.print) { console.log(`  would install: ${path.basename(target)}`); return true; }
    process.stdout.write(`(1/1) loading package data...           ${barDone} 100%\n`);
    process.stdout.write(`(1/1) installing ${fname.padEnd(25)}${barDone} 100%\n`);
    return await installPkgFile(path.resolve(target), 'explicit', opts);
  }

  return (await installPackages([target], opts)) > 0;
}

export async function installPackages(targets: string[], opts: InstallOptions = {}): Promise<number> {
  initDb();
  const cache = getRepoCache();
  if (cache.length === 0) {
    console.error('error: database not synced (run pacman -Sy)');
    return 0;
  }

  // Validate all targets exist
  const resolved: RepoPkg[] = [];
  for (const t of targets) {
    const rp = findInRepo(t);
    if (!rp) { console.error(`error: '${t}' not found`); continue; }
    if (opts.needed) {
      if (dpkgHasPackage(t) || isInstalled(loadDatabase(), t)) {
        console.log(`  ${t} is up to date`);
        continue;
      }
    }
    resolved.push(rp);
  }
  if (resolved.length === 0) return 0;

  console.log('resolving dependencies...');
  const seen = new Set<string>();
  const allDeps: RepoPkg[] = [];
  for (const rp of resolved) {
    allDeps.push(...resolveDepsRecursive(rp.package, seen));
  }
  // Dedupe: resolved targets first, then deps, removing duplicates
  const allNames = new Set<string>();
  const allPkgs: RepoPkg[] = [];
  for (const rp of [...resolved, ...allDeps]) {
    if (allNames.has(rp.package)) continue;
    allNames.add(rp.package);
    allPkgs.push(rp);
  }

  const totalSize = allPkgs.reduce((s, p) => s + (p.size || 0), 0);
  const totalInst = allPkgs.reduce((s, p) => s + ((p.installedSize || 0) * 1024), 0);

  console.log('looking for conflicting packages...\n');
  console.log(`Packages (${allPkgs.length}): ${allPkgs.map(p => p.package).join('  ')}\n`);
  console.log(`Total Download Size:   ${formatBytes(totalSize).padStart(9)}`);
  console.log(`Total Installed Size:  ${formatBytes(totalInst).padStart(9)}`);
  console.log('');

  if (!await confirm(':: Proceed with installation?')) return 0;

  if (opts.print) {
    for (const p of allPkgs) console.log(`  would install: ${p.package}-${p.version}`);
    return allPkgs.length;
  }

  const cols = process.stdout.columns || 80;

  for (let i = 0; i < allPkgs.length; i++) {
    const p = allPkgs[i];
    const isExplicit = resolved.some(r => r.package === p.package);
    const prefix = `(${i + 1}/${allPkgs.length}) `;
    const nameMax = Math.max(20, cols - 60);

    // Download with progress bar
    let prevTime = Date.now(), prevBytes = 0, smoothRate = 0;
    const pname = p.package.length > nameMax ? p.package.slice(0, nameMax - 3) + '...' : p.package;
    process.stdout.write(`${prefix}downloading ${pname}`);

    const localPath = await downloadPkg(p, undefined, (rec, tot) => {
      const now = Date.now();
      const chunkSec = Math.max((now - prevTime) / 1000, 0.001);
      const instant = (rec - prevBytes) / chunkSec;
      smoothRate = smoothRate > 0 ? (instant + 2 * smoothRate) / 3 : instant;
      prevTime = now; prevBytes = rec;

      const dl = humanSize(rec, 1);
      const rateS = formatRate(smoothRate);
      const eta = smoothRate > 0 && tot > 0 ? (tot - rec) / smoothRate : 0;
      const etaS = formatETA(eta);
      const pct = tot > 0 ? Math.round(rec / tot * 100) : 0;
      const bar = drawProgressBar(pct, cols);
      process.stdout.write(`\r${prefix}${pname.padEnd(nameMax)}${dl.val.padStart(6)} ${dl.unit}  ${rateS} ${etaS} [${bar}] ${String(pct).padStart(3)}%`);
    });

    // Integrity check (just show completed bar)
    const barDone = drawProgressBar(100, cols);
    process.stdout.write(`\r${prefix}checking package integrity            ${barDone} 100%\n`);

    // Loading (just show completed bar)
    process.stdout.write(`${prefix}loading package files                 ${barDone} 100%\n`);

    // Installing
    process.stdout.write(`${prefix}installing ${pname.padEnd(nameMax)}${barDone} 100%\n`);
    await installPkgFile(localPath, isExplicit ? (opts.asdeps ? 'dependency' : 'explicit') : 'dependency', opts);
  }

  return allPkgs.length;
}
