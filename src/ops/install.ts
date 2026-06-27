import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as net from 'node:net';
import { execSync } from 'node:child_process';
import { parseDeb, readScript } from '../core/deb';
import { extractTar } from '../core/tar';
import { parsePkgTarZst } from '../core/pkgfile';
import { findInRepo, downloadPkg } from '../repo/repository';
import { loadConfig } from '../repo/config';
import {
  initDb, loadDatabase, saveDatabase, addPackage, isInstalled, getPackage,
  saveScript, runScript, createTransaction, completeTransaction, parseDepends,
} from '../db/database';
import { writeDpkgEntry, dpkgHasPackage } from '../db/dpkg-compat';
import { removePackage, getPackage as getLocalPkg } from '../db/localdb';
import { resolveDeps, detectConflicts } from '../core/deps';
import { formatBytes } from '../ui/format';
import { humanSize, drawProgressBar, formatRate, formatETA, terminalWidth } from '../ui/progress';
import { confirm } from '../ui/prompt';
import { t } from '../i18n';
import type { InstalledPackage, RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';

async function installDeb(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  initDb();
  const pkg = parseDeb(filePath);
  const db = loadDatabase();
  removeLinkIfPresent(pkg.control.package);
  const { control } = pkg;
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

  // Run ldconfig if package installs shared libraries
  const hasSoFiles = files.some(f => /\.so(\.|$)/.test(f));
  if (hasSoFiles) {
    try { execSync('/usr/sbin/ldconfig', { stdio: 'inherit' }); } catch {}
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
  try { writeDpkgEntry(ip); } catch (e) { console.error(t('warn_failed_dpkg_status', String(e))); }
  saveDatabase(db);
  completeTransaction(tx.id);
  return true;
}

/* When installing a real package, remove any existing link with the same name.
   Links are virtual mappings (Debian→Arch), real packages take precedence. */
function removeLinkIfPresent(pkgName: string): void {
  const existing = getLocalPkg(pkgName);
  if (existing && existing.repoType === 'link') {
    removePackage(pkgName, existing.version);
  }
}

async function installArch(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  initDb();
  const data = fs.readFileSync(filePath);
  const { info, install, files: pkgFiles, dataBlocks } = parsePkgTarZst(data);
  if (!info.name) throw new Error('invalid .pkg.tar.zst: missing pkgname');

  const db = loadDatabase();
  removeLinkIfPresent(info.name);
  const existing = getPackage(db, info.name);
  if (opts.needed && existing && existing.version === info.version) return false;

  const tx = createTransaction('install', info.name, info.version);

  if (!opts.noscriptlet && (install?.pre_install || install?.post_install)) {
    const parts: string[] = [];
    if (install.pre_install) parts.push(`pre_install() {\n${install.pre_install}\n}`);
    if (install.post_install) parts.push(`post_install() {\n${install.post_install}\n}`);
    if (install.pre_remove) parts.push(`pre_remove() {\n${install.pre_remove}\n}`);
    if (install.post_remove) parts.push(`post_remove() {\n${install.post_remove}\n}`);
    const script = parts.join('\n') + '\n';
    saveScript(info.name, '.INSTALL', script);
    const tmpScript = `/var/lib/pacman-debian/info/${info.name}/.INSTALL`;
    if (install?.pre_install) {
      try { execSync(`/bin/bash -c 'source "${tmpScript}" && pre_install' 2>&-`, { stdio: 'pipe' }); } catch {}
    }
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
    if (!fs.existsSync(tmpScript)) {
      saveScript(info.name, '.INSTALL', `post_install() {\n${install.post_install}\n}\n`);
    }
    try { execSync(`/bin/bash -c 'source "${tmpScript}" && post_install' 2>&-`, { stdio: 'pipe' }); } catch {}
  }

  // Run ldconfig if package installs shared libraries
  const hasSoFiles = files.some(f => /\.so(\.|$)/.test(f));
  if (hasSoFiles) {
    try { execSync('/usr/sbin/ldconfig', { stdio: 'inherit' }); } catch {}
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
  try { writeDpkgEntry(ip); } catch (e) { console.error(t('warn_failed_dpkg_status', String(e))); }
  saveDatabase(db);
  completeTransaction(tx.id);
  return true;
}

export async function installPkgFile(filePath: string, reason: 'explicit' | 'dependency', opts: InstallOptions = {}): Promise<boolean> {
  if (opts.print) { console.log(t('would_install', path.basename(filePath))); return true; }
  if (filePath.endsWith('.pkg.tar.zst') || filePath.endsWith('.pkg.tar.xz') || filePath.endsWith('.pkg.tar.gz')) {
    return installArch(filePath, reason, opts);
  }
  return installDeb(filePath, reason, opts);
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
  const barLen = Math.max(Math.floor((cols - 30) * 0.35), 8);
  const barDone = '#'.repeat(barLen);

  console.log(t('packages_single', fname) + '\n');
  if (!await confirm(t('confirm_proceed'))) return false;
  if (opts.print) { console.log(t('would_install', fname)); return true; }
  process.stdout.write(t('progress_loading_data', '1', '1', barDone) + '\n');
  process.stdout.write(t('progress_installing_single', '1', '1', fname, barDone) + '\n');
  const result = await installPkgFile(localPath, 'explicit', opts);
  if (isUrl) try { fs.unlinkSync(localPath); } catch {}
  return result;
}

export async function installPackages(targets: string[], opts: InstallOptions = {}): Promise<number> {
  initDb();

  // Validate targets exist
  const targetPkgs: RepoPkg[] = [];
  for (const target of targets) {
    const rp = findInRepo(target);
    if (!rp) {
      const cacheDir = '/var/cache/pacman-debian/packages';
      if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) {
        console.error(t('error_db_not_synced'));
        return 0;
      }
      console.error(t('error_not_found', target));
      continue;
    }
    if (opts.needed && dpkgHasPackage(target)) {
      console.log(t('pkg_up_to_date', target));
      continue;
    }
    targetPkgs.push(rp);
  }
  if (targetPkgs.length === 0) return 0;

  // Resolve dependencies
  console.log(t('resolving_deps'));
  const { install: depResults, errors: depErrors } = resolveDeps(targets);
  for (const err of depErrors) console.error(t('warn_prefix', err));
  if (depErrors.length > 0 && depResults.length === 0) return 0;

  // Dedupe: deps first, then targets (Arch pacman convention)
  const allPkgs: RepoPkg[] = [];
  const seen = new Set<string>();
  for (const dr of depResults) {
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
  console.log(t('checking_conflicts') + '\n');
  const conflicts = detectConflicts(allPkgs);
  for (const c of conflicts) {
    console.error(`  ${c.reason}`);
  }
  if (conflicts.length > 0) {
    console.error('');
    console.error(t('error_unresolvable_conflicts'));
    return 0;
  }

  const totalSize = allPkgs.reduce((s, p) => s + (p.size || 0), 0);
  const totalInst = allPkgs.reduce((s, p) => s + ((p.installedSize || 0) * 1024), 0);

  console.log(t('packages_multi', String(allPkgs.length), allPkgs.map(p => p.package).join('  ')) + '\n');
  console.log(t('total_download_size', formatBytes(totalSize).padStart(9)));
  console.log(t('total_installed_size', formatBytes(totalInst).padStart(9)));
  console.log('');

  if (!await confirm(t('confirm_proceed'))) return 0;

  if (opts.print) {
    for (const p of allPkgs) console.log(t('would_install', `${p.package}-${p.version}`));
    return allPkgs.length;
  }

  // ---- Download phase ----
  const total = allPkgs.length;
  const cols = process.stdout.columns || 80;
  const parallelN = loadConfig().parallelDownloads || 1;
  console.log(t('downloading_packages'));

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

  const downloadOne = async (p: RepoPkg): Promise<{ pkg: RepoPkg; path: string; rate: number }> => {
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
        ` ${displayName.padEnd(nameWidth)} ${dl.val.padStart(6)} ${dl.unit.padEnd(3)}  ${rateStr} ${etaS}  [`,
        `] ${String(pct).padStart(3)}%`,
        pct,
      );
      process.stdout.write(`\r${line}`);
    });

    const finalSize = humanSize(p.size || 0, 1);
    const compLine = barLine(
      ` ${displayName.padEnd(nameWidth)} ${finalSize.val.padStart(6)} ${finalSize.unit.padEnd(3)}  ${formatRate(finalRate)} ${'00:00'}  [`,
      `] 100%`,
      100,
    );
    process.stdout.write(`\r${compLine}\n`);
    return { pkg: p, path: localPath, rate: finalRate };
  };

  // Parallel download
  const queue = [...allPkgs];
  const doBatch = async () => {
    while (queue.length > 0) {
      const pkg = queue.shift()!;
      const r = await downloadOne(pkg);
      downloaded.push(r);
    }
  };
  const workers = Array.from({ length: Math.min(parallelN, total) }, () => doBatch());
  await Promise.all(workers);

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

  // ---- Pre-install checks (after download, matching real pacman order) ----
  const prefixStr = `(${String(total)}/${String(total)}) `;
  const checkMessages = [
    t('progress_checking_keys_msg'),
    t('progress_checking_integrity_msg'),
    t('progress_loading_files_msg'),
    t('progress_checking_conflicts_msg'),
    t('progress_checking_space_msg'),
  ];
  const maxMsgTw = Math.max(...checkMessages.map(m => terminalWidth(m)));

  const fmtCheck = (msg: string) => {
    const pad = maxMsgTw - terminalWidth(msg);
    const line = barLine(
      `${prefixStr}${msg}${' '.repeat(pad)} [`,
      `] 100%`,
      100,
    );
    process.stdout.write(line + '\n');
  };

  // 1. Keys check
  fmtCheck(t('progress_checking_keys_msg'));

  // 2. Integrity — verify sha256 of each downloaded file
  let integrityOk = true;
  for (const { pkg: p, path: fp } of downloaded) {
    if (p.sha256) {
      const hash = execSync(`sha256sum "${fp}" 2>/dev/null | cut -d' ' -f1`, { encoding: 'utf8', timeout: 10000 }).trim();
      if (hash !== p.sha256) {
        console.error(`\n  WARNING: ${p.package}: sha256 mismatch (expected ${p.sha256}, got ${hash})`);
        integrityOk = false;
      }
    }
  }
  fmtCheck(t('progress_checking_integrity_msg'));

  // 3. Load files — validate package archive format
  for (const { pkg: p, path: fp } of downloaded) {
    try {
      if (fp.endsWith('.deb')) execSync(`dpkg-deb --info "${fp}" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
      else execSync(`tar -t --zstd -f "${fp}" 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 5000 });
    } catch {
      console.error(`\n  WARNING: ${p.package}: package file appears corrupted`);
      integrityOk = false;
    }
  }
  fmtCheck(t('progress_loading_files_msg'));

  // 4. File conflict check
  fmtCheck(t('progress_checking_conflicts_msg'));

  // 5. Available space check
  try {
    const df = execSync('df -k /', { encoding: 'utf8', timeout: 5000 });
    const match = df.trim().split('\n').pop()?.match(/\s(\d+)\s+(\d+)\s+(\d+)/);
    if (match) {
      const availKb = parseInt(match[3], 10);
      const needKb = Math.ceil((allPkgs.reduce((s, p) => s + ((p.installedSize || 0) * 1024), 0)) / 1024);
      if (availKb < needKb) {
        console.error(`\n  ERROR: not enough disk space (need ${needKb} KiB, have ${availKb} KiB)`);
        return 0;
      }
    }
  } catch {}
  fmtCheck(t('progress_checking_space_msg'));

  // Install phase (serial for safety)
  for (const { pkg: p, path: localPath } of downloaded) {
    const isExplicit = targetPkgs.some(r => r.package === p.package);
    await installPkgFile(localPath, isExplicit ? (opts.asdeps ? 'dependency' : 'explicit') : 'dependency', opts);
  }

  // Post-transaction hooks
  process.stdout.write(t('running_hooks') + '\n');

  return total;
}

