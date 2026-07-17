import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as net from 'node:net';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseDeb, readScript } from '../core/deb';
import { listTarEntries } from '../core/tar';
import { extractTar, safeTargetPath } from '../core/tar';
import type { ProgressCallback } from '../core/tar';
import { parsePkgTarZst } from '../core/pkgfile';
import { logInstall, logError } from '../core/logger';
import { findInRepo, findInRepoScoped, findInRepoVersioned, downloadPkg } from '../repo/repository';
import { loadConfig } from '../repo/config';
import {
  initDb, loadDatabase, saveDatabase, addPackage, isInstalled, getPackage,
  saveScript, runScript, createTransaction, completeTransaction, parseDepends,
} from '../db/database';
import { writeDpkgEntry, dpkgHasPackage, readDpkgStatus } from '../db/dpkg-compat';
import { acquireDpkgLock, releaseDpkgLock } from '../lock/dpkg-lock';
import { removePackage, getPackage as getLocalPkg } from '../db/localdb';
import { resolveDeps, detectConflicts } from '../core/deps';
import { formatBytes } from '../ui/format';
import { color } from '../ui/colors';
import { humanSize, drawProgressBar, formatRate, formatETA, terminalWidth } from '../ui/progress';
import { confirm } from '../ui/prompt';
import { t } from '../i18n';
import type { InstalledPackage, RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';

function sourceRepo(pkg: InstalledPackage): string {
  return pkg.repo || pkg.repoType || 'unknown';
}

function distRepo(pkg: RepoPkg): string {
  return pkg.repo || pkg.repoType || 'unknown';
}

function refreshLoaderCache(): void {
  try { execSync('/usr/sbin/ldconfig', { stdio: 'inherit' }); } catch {}
}

async function confirmSourceTakeover(items: Array<{ existing: InstalledPackage; incoming: RepoPkg }>, opts: InstallOptions): Promise<boolean> {
  if (items.length === 0 || opts.takeoverConfirmed) return true;
  for (const { existing, incoming } of items) {
    if (existing.repoType === incoming.repoType) continue;
    console.warn(color.warn(t('source_takeover_warning', existing.name, sourceRepo(existing), distRepo(incoming))));
  }
  return confirm(t('source_takeover_confirm'), false);
}

function archiveTakeovers(downloaded: Array<{ pkg: RepoPkg; path: string }>, db: ReturnType<typeof loadDatabase>): Array<{ existing: InstalledPackage; incoming: RepoPkg }> {
  const result = new Map<string, { existing: InstalledPackage; incoming: RepoPkg }>();
  for (const { pkg, path: filePath } of downloaded) {
    let files: string[] = [];
    try {
      if (filePath.endsWith('.deb')) {
        files = listTarEntries(parseDeb(filePath).dataTar)
          .filter(name => !name.endsWith('/'))
          .map(name => `/${name.replace(/^\.\//, '').replace(/^\/+/, '')}`);
      } else {
        files = parsePkgTarZst(fs.readFileSync(filePath)).files.filter(name => !name.endsWith('/'));
      }
    } catch { continue; }
    for (const file of files) {
      const ownerName = db.fileIndex.get(file);
      if (!ownerName || ownerName === pkg.package) continue;
      const existing = db.packages.get(ownerName);
      if (existing && existing.repoType && existing.repoType !== pkg.repoType) result.set(`${ownerName}:${pkg.package}`, { existing, incoming: pkg });
    }
  }
  return [...result.values()];
}

async function installDeb(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}, onProgress?: ProgressCallback): Promise<boolean> {
  initDb();
  const pkg = parseDeb(filePath);
  const db = loadDatabase();
  removeLinkIfPresent(pkg.control.package);
  const { control } = pkg;
  const existing = getPackage(db, control.package);
  const _cfg = loadConfig();

  if (opts.needed && existing && existing.version === control.version) {
    return false;
  }
  if (existing && existing.version === control.version) {
    const realFiles = existing.files.filter(f => { try { return !fs.lstatSync(f).isDirectory(); } catch { return false; } });
    if (realFiles.length > 0) return true;
  }

   await acquireDpkgLock();
   try {
   const tx = createTransaction('install', control.package, control.version);
   refreshLoaderCache();
  if (!opts.noscriptlet) {
    const preinst = readScript(pkg, 'preinst');
    if (preinst) saveScript(control.package, 'preinst', preinst);
    if (!runScript(control.package, 'preinst', ['install'])) throw new Error(`${control.package}: preinst failed`);
  }

   const files = extractTar(pkg.dataTar, '/', onProgress, _cfg.noExtract, _cfg.noUpgrade);
   refreshLoaderCache();

  if (!opts.noscriptlet) {
    const postinst = readScript(pkg, 'postinst');
    if (postinst) saveScript(control.package, 'postinst', postinst);
    if (!runScript(control.package, 'postinst', ['configure'])) throw new Error(`${control.package}: postinst failed`);
  }

   refreshLoaderCache();

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
    installTime: Date.now(), reason, files, repo: opts.repo,
  };

  addPackage(db, ip);
  try { await writeDpkgEntry(ip); } catch (e) { console.error(t('warn_failed_dpkg_status', String(e))); }
  saveDatabase(db);
  completeTransaction(tx.id);
  return true;
  } finally { releaseDpkgLock(); }
}

/* When installing a real package, remove any existing link with the same name.
   Links are virtual mappings (Debian→Arch), real packages take precedence. */
function removeLinkIfPresent(pkgName: string): void {
  const existing = getLocalPkg(pkgName);
  if (existing && existing.repoType === 'link') {
    removePackage(pkgName, existing.version);
  }
}

async function installArch(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}, onProgress?: ProgressCallback): Promise<boolean> {
  initDb();
  const data = fs.readFileSync(filePath);
  const { info, install, files: pkgFiles, dataBlocks } = parsePkgTarZst(data);
  if (!info.name) throw new Error('invalid .pkg.tar.zst: missing pkgname');

  const db = loadDatabase();
  removeLinkIfPresent(info.name);
  const existing = getPackage(db, info.name);
  if (opts.needed && existing && existing.version === info.version) return false;
  await acquireDpkgLock();
   try {
   const tx = createTransaction('install', info.name, info.version);
   refreshLoaderCache();

   // A Debian-installed package may not have a pacman-debian local record
   // yet. It is still an upgrade, and its Arch .INSTALL may only define the
   // post_upgrade hook.
   const dpkgExisting = readDpkgStatus().get(info.name);
   const isUpgrade = !!existing || !!dpkgExisting;
   const oldVersion = existing?.version || dpkgExisting?.version || '';
  const scriptBin = '/tmp/pacman-debian-script-bin';
  fs.mkdirSync(scriptBin, { recursive: true });
  const vercmpPath = path.join(scriptBin, 'vercmp');
  fs.writeFileSync(vercmpPath, `#!/bin/sh\nnode -e 'const d=require("${path.resolve(__dirname, '../core/deps.js')}"); process.stdout.write(String(d.verCmp(process.argv[1], process.argv[2])) + "\\n")' "$1" "$2"\n`, { mode: 0o755 });
  const scriptEnv = { ...process.env, PATH: `${scriptBin}:${process.env.PATH || '/usr/bin:/bin'}` };
  if (!opts.noscriptlet && (install?.pre_install || install?.post_install || install?.pre_upgrade || install?.post_upgrade)) {
    const parts: string[] = [];
    if (install.pre_install) parts.push(`pre_install() {\n${install.pre_install}\n}`);
    if (install.post_install) parts.push(`post_install() {\n${install.post_install}\n}`);
    if (install.pre_upgrade) parts.push(`pre_upgrade() {\n${install.pre_upgrade}\n}`);
    if (install.post_upgrade) parts.push(`post_upgrade() {\n${install.post_upgrade}\n}`);
    if (install.pre_remove) parts.push(`pre_remove() {\n${install.pre_remove}\n}`);
    if (install.post_remove) parts.push(`post_remove() {\n${install.post_remove}\n}`);
    const script = parts.join('\n') + '\n';
    saveScript(info.name, '.INSTALL', script);
    const tmpScript = `/var/lib/pacman-debian/info/${info.name}/.INSTALL`;
    const preHook = isUpgrade ? 'pre_upgrade' : 'pre_install';
    if (install?.[preHook]) {
      try { execSync(`/bin/bash -c 'source "${tmpScript}" && ${preHook} "$1" "$2"' -- "${info.version}" "${oldVersion}"`, { stdio: 'inherit', env: scriptEnv, cwd: '/' }); }
      catch { throw new Error(`${info.name}: ${preHook} failed`); }
    }
  }

  const files: string[] = [];
  const total = dataBlocks.length;
  const _archCfg = loadConfig();
  const matchArch = (p: string, name: string) => p === name || p === '/' + name || (p.endsWith('/*') && name.startsWith(p.slice(0, -1)));
  for (let i = 0; i < total; i++) {
    const entry = dataBlocks[i];
     const targetPath = safeTargetPath('/', entry.name);
    files.push('/' + entry.name);
    if (_archCfg.noExtract.some(p => matchArch(p, entry.name))) continue;
    if (entry.data) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (_archCfg.noUpgrade.some(p => matchArch(p, entry.name)) && fs.existsSync(targetPath)) {
        const bak = targetPath + '.pacnew';
        const tmp = `${bak}.pacman-debian.tmp-${process.pid}`;
        fs.writeFileSync(tmp, entry.data, { mode: 0o755 });
        fs.renameSync(tmp, bak);
      } else {
        if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) fs.unlinkSync(targetPath);
        const tmp = `${targetPath}.pacman-debian.tmp-${process.pid}`;
        fs.writeFileSync(tmp, entry.data, { mode: 0o755 });
        fs.renameSync(tmp, targetPath);
      }
    }
    onProgress?.(i + 1, total, entry.name);
  }

   // Hooks may execute binaries or shared libraries from this package.
   refreshLoaderCache();

  if (!opts.noscriptlet && (install?.post_install || install?.post_upgrade)) {
    const tmpScript = `/var/lib/pacman-debian/info/${info.name}/.INSTALL`;
    if (!fs.existsSync(tmpScript)) {
      saveScript(info.name, '.INSTALL', `post_install() {\n${install.post_install || ''}\n}\npost_upgrade() {\n${install.post_upgrade || ''}\n}\n`);
    }
    const postHook = isUpgrade ? 'post_upgrade' : 'post_install';
   try { execSync(`/bin/bash -c 'source "${tmpScript}" && ${postHook} "$1" "$2"' -- "${info.version}" "${oldVersion}"`, { stdio: 'inherit', env: scriptEnv, cwd: '/' }); }
   catch { throw new Error(`${info.name}: ${postHook} failed`); }
   }
   refreshLoaderCache();

  const ip: InstalledPackage = {
    name: info.name, version: info.version,
    architecture: info.arch || 'any',
    description: info.description || '',
    depends: (info.depends || []).join(', '),
    conflicts: (info.conflicts || []).join(', '),
    provides: (info.provides || []).join(', '),
    maintainer: info.packager,
    homepage: info.url,
    license: (info.license || []).join(', '), pkgbase: info.base, buildDate: info.buildDate,
    controlSection: 'misc', controlPriority: 'optional',
    installedSize: info.installedSize ?? (info.size ? Math.ceil(info.size / 1024) : undefined),
    installTime: Date.now(), reason, files, repoType: 'arch',
    repo: opts.repo,
  };

  addPackage(db, ip);
  try { await writeDpkgEntry(ip); } catch (e) { console.error(t('warn_failed_dpkg_status', String(e))); }
  saveDatabase(db);
  completeTransaction(tx.id);
  return true;
  } finally { releaseDpkgLock(); }
}

export async function installPkgFile(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}, onProgress?: ProgressCallback): Promise<boolean> {
  if (opts.print) { console.log(t('would_install', path.basename(filePath))); return true; }
  if (filePath.endsWith('.pkg.tar.zst') || filePath.endsWith('.pkg.tar.xz') || filePath.endsWith('.pkg.tar.gz')) {
    return installArch(filePath, reason, opts, onProgress);
  }
  return installDeb(filePath, reason, opts, onProgress);
}

function parseFtpUrl(url: string): { host: string; port: number; user: string; pass: string; path: string } {
  const rest = url.slice(6);
  const atIdx = rest.lastIndexOf('@');
  let user = 'anonymous', pass = 'pacman-debian@';
  let hostPart: string;
  if (atIdx > 0) {
    const auth = rest.slice(0, atIdx);
    const colonIdx = auth.indexOf(':');
    user = colonIdx >= 0 ? auth.slice(0, colonIdx) : auth;
    pass = colonIdx >= 0 ? auth.slice(colonIdx + 1) : '';
    hostPart = rest.slice(atIdx + 1);
  } else {
    hostPart = rest;
  }
  const slashIdx = hostPart.indexOf('/');
  const hostPort = slashIdx >= 0 ? hostPart.slice(0, slashIdx) : hostPart;
  const path = slashIdx >= 0 ? hostPart.slice(slashIdx) : '/';
  const colonIdx = hostPort.lastIndexOf(':');
  const host = colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
  const port = colonIdx >= 0 ? parseInt(hostPort.slice(colonIdx + 1), 10) : 21;
  return { host, port, user, pass, path };
}

function ftpReadReply(sock: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (data: Buffer) => {
      buf += data.toString();
      if (buf.includes('\r\n')) { sock.off('data', onData); resolve(buf.trim()); }
    };
    sock.on('data', onData);
  });
}

function ftpCommand(sock: net.Socket, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sock.write(cmd + '\r\n');
    let buf = '';
    const onData = (data: Buffer) => {
      buf += data.toString();
      if (buf.length >= 4 && buf[3] === ' ') { sock.off('data', onData); resolve(buf.trim()); }
    };
    sock.on('data', onData);
    setTimeout(() => { sock.off('data', onData); reject(new Error('FTP command timeout')); }, 15000);
  });
}

async function downloadFtp(url: string, dest: string): Promise<void> {
  const { host, port, user, pass, path } = parseFtpUrl(url);
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const chunks: Buffer[] = [];
    let dataSock: net.Socket | null = null;

    sock.connect(port, host, async () => {
      try {
        await ftpReadReply(sock); // greeting
        await ftpCommand(sock, `USER ${user}`);
        await ftpCommand(sock, `PASS ${pass}`);

        // PASV
        const pasvResp = await ftpCommand(sock, 'PASV');
        const m = pasvResp.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
        if (!m) { reject(new Error('Failed to parse PASV response')); sock.end(); return; }
        const dataHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
        const dataPort = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);

        dataSock = new net.Socket();
        dataSock.connect(dataPort, dataHost, () => {
          ftpCommand(sock, `RETR ${path}`).catch(() => {});
        });

        dataSock.on('data', (data: Buffer) => chunks.push(data));
        dataSock.on('end', () => {
          ftpCommand(sock, 'QUIT').catch(() => {});
          const buf = Buffer.concat(chunks);
          fs.writeFileSync(dest, buf);
          sock.end();
          resolve();
        });
        dataSock.on('error', (e) => { reject(e); sock.end(); });
      } catch (e) { reject(e); sock.end(); }
    });
    sock.on('error', reject);
  });
}

async function downloadUrl(url: string, dest: string): Promise<void> {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { 'User-Agent': 'pacman-debian/7.2.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : url;
        downloadUrl(next, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    }).on('error', reject);
  });
}

export async function installPkg(target: string, opts: InstallOptions = {}): Promise<boolean> {
  const cacheDir = '/var/cache/pacman-debian';
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  let localPath: string;
  let fname: string;
  let isUrl = false;

  if (target.startsWith('file://')) {
    localPath = target.slice(7);
    if (!fs.existsSync(localPath)) { console.error(`error: file not found: ${localPath}`); return false; }
    fname = path.basename(localPath).replace(/\.(pkg\.tar\.(zst|xz|gz)|deb)$/, '');
  } else if (target.includes('://')) {
    isUrl = true;
    const ext = target.match(/\.(deb|pkg\.tar\.(zst|xz|gz))$/)?.[0];
    if (!ext) { console.error('error: unsupported package URL'); return false; }
    fname = path.basename(target);
    localPath = path.join(cacheDir, fname);
    if (!fs.existsSync(localPath)) {
      process.stdout.write(`downloading ${fname}...\n`);
      try {
        if (target.startsWith('ftp://')) await downloadFtp(target, localPath);
        else await downloadUrl(target, localPath);
      } catch (e: any) {
        console.error(`error: failed to download: ${e.message}`);
        return false;
      }
    }
  } else if (fs.existsSync(target) && ['.deb', '.pkg.tar.zst', '.pkg.tar.xz', '.pkg.tar.gz'].some(e => target.endsWith(e))) {
    localPath = path.resolve(target);
    fname = path.basename(target).replace(/\.(pkg\.tar\.(zst|xz|gz)|deb)$/, '');
  } else {
    console.error(`error: target '${target}' is not a package file or URL`);
    return false;
  }

  const cols = process.stdout.columns || 80;
  const barLen = Math.max(cols - 50, 8);
  const drawBar = (pct: number) => {
    const filled = Math.round((pct / 100) * barLen);
    return `[${'#'.repeat(filled)}${'-'.repeat(barLen - filled)}] ${String(pct).padStart(3)}%`;
  };

  console.log(color.title(t('packages_single', fname)) + '\n');
  if (!await confirm(t('confirm_proceed'))) return true;
  if (opts.print) { console.log(t('would_install', fname)); return true; }
  process.stdout.write(`(1/1) ${t('progress_loading_files_msg')} ${drawBar(0)}`);
  let lastName = '';
  try {
    const result = await installPkgFile(localPath, 'explicit', opts, (current, total, name) => {
      const pct = total > 0 ? Math.round(current / total * 100) : 100;
      lastName = name;
      process.stdout.write(`\r\x1b[K(1/1) ${t('progress_loading_files_msg')} ${name} ${drawBar(pct)}`);
    });
    process.stdout.write(`\r\x1b[K(1/1) installing ${fname} ${drawBar(100)}\n`);
    if (isUrl) try { fs.unlinkSync(localPath); } catch {}
    return result;
  } catch (error) {
    process.stdout.write(`\r\x1b[K`);
    console.error(`error: failed to install ${fname}${lastName ? ` near ${lastName}` : ''}: ${(error as Error).message}`);
    if (isUrl) try { fs.unlinkSync(localPath); } catch {}
    return false;
  }
}

export async function installPackages(targets: string[], opts: InstallOptions = {}): Promise<number> {
  initDb();

  // Validate targets exist (support repo/pkgname syntax)
  const targetPkgs: RepoPkg[] = [];
  for (const [index, target] of targets.entries()) {
    const sl = target.indexOf('/');
    const repo = sl > 0 ? target.slice(0, sl) : undefined;
    const requested = sl > 0 ? target.slice(sl + 1) : target;
    const eq = requested.indexOf('=');
    const name = eq >= 0 ? requested.slice(0, eq) : requested;
    const version = eq >= 0 ? requested.slice(eq + 1) : undefined;
    const rp = opts.preparedPackages?.[index] || (version ? findInRepoVersioned(name, version, repo)
      : (repo ? findInRepoScoped(repo, name) : findInRepo(name)));
    const displayName = target;
    if (!rp) {
      const cacheDir = '/var/cache/pacman-debian/packages';
      if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) {
        console.error(t('error_db_not_synced'));
        throw new Error('package database is not synchronized');
      }
      console.error(t('error_not_found', displayName));
      throw new Error(`target not found: ${displayName}`);
    }
    if (opts.needed && dpkgHasPackage(name)) {
      console.log(t('pkg_up_to_date', name));
      continue;
    }
    targetPkgs.push(rp);
  }
  if (targetPkgs.length === 0) return 0;

  // Resolve dependencies
  if (!opts.skipDependencyResolution) console.log(color.title(t('resolving_deps')));
  const preferredRepos = new Map<string, string[]>();
  if (!loadConfig().notFindDepsFromCurrentRepo) {
    for (const target of targets) {
      const slash = target.indexOf('/');
      const requested = slash > 0 ? target.slice(slash + 1) : target;
      const eq = requested.indexOf('=');
      const name = eq >= 0 ? requested.slice(0, eq) : requested;
      if (slash > 0) preferredRepos.set(name, [target.slice(0, slash)]);
    }
  }
  const depTargets = targets.map(target => {
    const slash = target.indexOf('/');
    const prefix = slash > 0 ? target.slice(0, slash + 1) : '';
    const requested = slash > 0 ? target.slice(slash + 1) : target;
    const eq = requested.indexOf('=');
    return prefix + (eq >= 0 ? requested.slice(0, eq) : requested);
  });
  const { install: depResults, errors: depErrors } = opts.skipDependencyResolution
    ? { install: [], errors: [] }
    : resolveDeps(depTargets, { preferredRepos });
  for (const err of depErrors) console.error(color.warn(t('warn_prefix', err)));
  if (depErrors.length > 0) throw new Error('dependency resolution failed');

  // Dedupe: deps first, then targets (Arch pacman convention)
  const allPkgs: RepoPkg[] = [];
  const seen = new Set<string>();
  const targetNames = new Set(targetPkgs.map(p => p.package));
  for (const dr of depResults) {
    // The explicit target below is authoritative, including an exact
    // `name=version` request; do not let an unversioned dependency lookup
    // replace it with the first repository match.
    if (targetNames.has(dr.pkg.package)) continue;
    if (seen.has(dr.pkg.package)) continue;
    seen.add(dr.pkg.package);
    allPkgs.push(dr.pkg);
  }
  for (const rp of targetPkgs) {
    if (seen.has(rp.package)) continue;
    seen.add(rp.package);
    allPkgs.push(rp);
  }

  // Conflict detection
  if (!opts.skipSummary) console.log(color.title(t('checking_conflicts')) + '\n');
  const conflicts = detectConflicts(allPkgs);
  for (const c of conflicts) {
    console.error(`  ${color.error(c.reason)}`);
  }
  if (conflicts.length > 0) {
    console.error('');
    console.error(color.error(t('error_unresolvable_conflicts')));
    throw new Error('unresolvable package conflicts detected');
  }

  const totalSize = allPkgs.reduce((s, p) => s + (p.size || 0), 0);
  const totalInst = allPkgs.reduce((s, p) => s + ((p.installedSize || 0) * 1024), 0);

  const _cfg = loadConfig();
  if (!opts.skipSummary && _cfg.verbosePkgLists) {
    const cols = process.stdout.columns || 80;
    const nameW = Math.max(20, Math.floor(cols * 0.3));
    const verW = Math.max(16, Math.floor(cols * 0.2));
    const repoW = Math.max(10, Math.floor(cols * 0.15));
    console.log(t('packages_multi', String(allPkgs.length), ''));
    console.log(`  ${'Name'.padEnd(nameW)} ${'Version'.padEnd(verW)} ${'Repo'.padEnd(repoW)} Size`);
    console.log(`  ${'─'.repeat(nameW)} ${'─'.repeat(verW)} ${'─'.repeat(repoW)} ${'─'.repeat(8)}`);
    for (const p of allPkgs) {
      const name = p.package.length > nameW ? p.package.slice(0, nameW - 3) + '...' : p.package;
      const ver = (p.version || '').length > verW ? (p.version || '').slice(0, verW - 3) + '...' : (p.version || '');
      console.log(`  ${color.pkg(name.padEnd(nameW))} ${color.title(ver.padEnd(verW))} ${color.repo(p.repo.padEnd(repoW))} ${color.size(formatBytes(p.size || 0).padStart(8))}`);
    }
  } else if (!opts.skipSummary) {
    console.log(t('packages_multi', String(allPkgs.length), allPkgs.map(p => color.pkg(p.package)).join('  ')));
  }
  if (!opts.skipSummary) {
    console.log('');
    console.log(t('total_download_size', color.size(formatBytes(totalSize).padStart(9))));
    console.log(t('total_installed_size', color.size(formatBytes(totalInst).padStart(9))));
    console.log('');
  }

  const takeover = new Map<string, { existing: InstalledPackage; incoming: RepoPkg }>();
  const currentDb = loadDatabase();
  for (const p of allPkgs) {
    const existing = currentDb.packages.get(p.package);
    if (existing && existing.repoType && existing.repoType !== p.repoType) takeover.set(p.package, { existing, incoming: p });
  }
  if (!opts.confirmed && !await confirm(t('confirm_proceed'))) return 0;

  if (opts.print) {
    for (const p of allPkgs) console.log(t('would_install', `${p.package}-${p.version}`));
    return allPkgs.length;
  }

  // ---- Transaction start ----
  console.log(t('processing_changes'));

  // ---- Download phase ----
  const total = allPkgs.length;
  const cols = process.stdout.columns || 80;
  const parallelN = loadConfig().parallelDownloads || 1;
  console.log(t('retrieving_packages'));

  const downloaded: { pkg: RepoPkg; path: string; rate: number }[] = [];
  const startTime = Date.now();

  /** Render a right-aligned progress bar line. leftText precedes `[`, rightText follows `]`. */
  const barLine = (leftText: string, rightText: string, pct: number): string => {
    const barLen = Math.max(cols - terminalWidth(leftText) - terminalWidth(rightText), 5);
    const line = `${leftText}${drawProgressBar(pct, barLen)}${rightText}`;
    if (terminalWidth(line) < cols) return line + ' '.repeat(cols - terminalWidth(line));
    return line;
  };

  const nameWidth = Math.max(25, Math.floor(cols * 0.35));
  let dlIdx = 0;

  // Keep concurrent downloads on separate terminal rows instead of allowing
  // workers to overwrite each other's single-line progress display.
  const activeRows = Math.min(parallelN, total);
  const downloadRows = Array.from({ length: activeRows }, () => '');
  const renderDownloadRow = (slot: number, line: string) => {
    downloadRows[slot] = line;
    if (opts.noProgressBar || !process.stdout.isTTY) return;
    const up = activeRows - slot;
    process.stdout.write(`\x1b[${up}A\r\x1b[2K${line}\x1b[${up}B`);
  };
  if (!opts.noProgressBar && process.stdout.isTTY && activeRows > 1) {
    process.stdout.write('\n'.repeat(activeRows));
  }

  const downloadOne = async (p: RepoPkg, slot: number): Promise<{ pkg: RepoPkg; path: string; rate: number }> => {
    const idx = ++dlIdx;
    const digits = String(total).length;
    const prefix = `(${String(idx).padStart(digits)}/${String(total).padEnd(digits)})`;
    const pkgLabel = `${p.package}-${p.version}-${p.architecture || 'any'}`;
    const displayName = pkgLabel.length > nameWidth ? pkgLabel.slice(0, nameWidth - 3) + '...' : pkgLabel;
    let finalRate = 0, prevTime = Date.now(), prevBytes = 0, smoothRate = 0;

    const localPath = await downloadPkg(p, undefined, (rec, tot) => {
      const now = Date.now();
      const chunkSec = Math.max((now - prevTime) / 1000, 0.001);
      const instant = (rec - prevBytes) / chunkSec;
      smoothRate = smoothRate > 0 ? (instant + 2 * smoothRate) / 3 : instant;
      prevTime = now; prevBytes = rec;
      finalRate = smoothRate;

      const dl = humanSize(rec, 1);
      const rateStr = formatRate(smoothRate);
      const eta = smoothRate > 0 && tot > 0 ? (tot - rec) / smoothRate : 0;
      const etaS = formatETA(eta);
      const pct = tot > 0 ? Math.round(rec / tot * 100) : 0;
      const line = barLine(
        ` ${prefix} ${displayName.padEnd(nameWidth)} ${dl.val.padStart(6)} ${dl.unit.padEnd(3)}  ${rateStr} ${etaS}  [`,
        `] ${String(pct).padStart(3)}%`,
        pct,
      );
      renderDownloadRow(slot, line);
    });

    const finalSize = humanSize(p.size || 0, 1);
    const compLine = barLine(
      ` ${prefix} ${displayName.padEnd(nameWidth)} ${finalSize.val.padStart(6)} ${finalSize.unit.padEnd(3)}  ${formatRate(finalRate)} ${'00:00'}  [`,
      `] 100%`,
      100,
    );
    if (opts.noProgressBar) return { pkg: p, path: localPath, rate: finalRate };
    renderDownloadRow(slot, compLine);
    if (!process.stdout.isTTY) process.stdout.write(compLine + '\n');
    return { pkg: p, path: localPath, rate: finalRate };
  };

  // Parallel download
  const queue = [...allPkgs];
  const doBatch = async (slot: number) => {
    while (queue.length > 0) {
      const pkg = queue.shift()!;
      const r = await downloadOne(pkg, slot);
      downloaded.push(r);
    }
  };
  const workers = Array.from({ length: activeRows }, (_, slot) => doBatch(slot));
  try {
    await Promise.all(workers);
  } catch (error) {
    throw new Error(`package download failed: ${(error as Error).message}`);
  }

  // File-level takeover can only be known after archives are available. Ask
  // once before integrity checks and any system mutation.
  if (!opts.takeoverConfirmed) {
    for (const item of archiveTakeovers(downloaded, currentDb)) {
      takeover.set(`${item.existing.name}:${item.incoming.package}`, item);
    }
    if (takeover.size > 0 && !await confirmSourceTakeover([...takeover.values()], opts)) {
      throw new Error('package source takeover cancelled');
    }
    if (takeover.size > 0) opts = { ...opts, takeoverConfirmed: true };
  }

  // 汇总行
  const totalSz = allPkgs.reduce((s, p) => s + (p.size || 0), 0);
  const elapsed = (Date.now() - startTime) / 1000;
  const totalRate = elapsed > 0 ? totalSz / elapsed : 0;
  const totalLabel = `${t('total_all')} (${String(total)}/${String(total)})`;
  const totalSizeStr = humanSize(totalSz, 1);
  const totalRateStr = formatRate(totalRate);
  const totalLine = barLine(
    ` ${totalLabel.padEnd(nameWidth)} ${totalSizeStr.val.padStart(6)} ${totalSizeStr.unit.padEnd(3)}  ${totalRateStr} ${'00:00'}  [`,
    `] 100%`,
    100,
  );
  process.stdout.write(totalLine + '\n');

  // Verify downloaded archives before changing the system. Run independent
  // checks concurrently so large upgrades do not wait on 89 serial processes.
  process.stdout.write(t('progress_checking_integrity_msg') + '\n');
  let integrityOk = true;
  const checkOne = async ({ pkg: p, path: fp }: { pkg: RepoPkg; path: string }) => {
    try {
      if (p.sha256) {
        const hash = createHash('sha256').update(await fs.promises.readFile(fp)).digest('hex');
        if (hash !== p.sha256) throw new Error(`sha256 mismatch (expected ${p.sha256}, got ${hash})`);
      }
      // Arch archives are parsed during installation; avoid a second full
      // decompression pass here just to validate the same bytes again.
      if (fp.endsWith('.deb')) parseDeb(fp);
    } catch (error) {
      console.error(`\n  ${color.warn('WARNING')}: ${color.pkg(p.package)}: ${(error as Error).message || 'package file appears corrupted'}`);
      integrityOk = false;
    }
  };
  await Promise.all(downloaded.map(checkOne));
  if (!integrityOk) throw new Error('package integrity check failed');

  const cfg = loadConfig();
  if (cfg.checkSpace) {
    try {
      const dfPath = cfg.rootDir === '/' ? '/' : cfg.rootDir;
      const df = execSync(`df -k "${dfPath}"`, { encoding: 'utf8', timeout: 5000 });
      const match = df.trim().split('\n').pop()?.match(/\s(\d+)\s+(\d+)\s+(\d+)/);
      if (match) {
        const availKb = parseInt(match[3], 10);
        const needKb = allPkgs.reduce((s, p) => s + ((p.installedSize || 0)), 0);
        if (availKb < needKb) {
          console.error(`\n  ${color.error('error')}: not enough disk space (need ${(needKb / 1024).toFixed(1)} MiB, have ${(availKb / 1024).toFixed(1)} MiB)`);
          throw new Error('not enough disk space');
        }
      }
    } catch (error) {
      if ((error as Error).message === 'not enough disk space') throw error;
    }
  }
  // Hold dpkg locks for the complete system-modifying transaction.
  await acquireDpkgLock();
  try {
    for (let i = 0; i < downloaded.length; i++) {
      const { pkg: p, path: localPath } = downloaded[i];
      const isExplicit = targetPkgs.some(r => r.package === p.package);
      const prefix = `(${String(i + 1).padStart(String(downloaded.length).length)}/${downloaded.length})`;
      process.stdout.write(`${t('progress_upgrading', String(i + 1), String(downloaded.length), color.pkg(p.package))}\n`);
      const ok = await installPkgFile(localPath, isExplicit ? (opts.asdeps ? 'dependency' : 'explicit') : 'dependency', { ...opts, repo: p.repo },
        (done, total, name) => {
          process.stdout.write(`\r\x1b[K${prefix} ${t('progress_loading_files_msg')} ${name} ${total > 0 ? Math.round(done / total * 100) : 100}%`);
          if (done >= total) process.stdout.write('\n');
        });
      if (!ok) throw new Error(`failed to install ${p.package}`);
    }

    // Post-transaction hooks
    process.stdout.write(t('running_hooks') + '\n');
  } finally {
    releaseDpkgLock();
  }

  return total;
}
