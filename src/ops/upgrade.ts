import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDpkgStatus } from '../db/dpkg-compat';
import { syncRepos, findInRepo, batchFindInRepo, downloadPkg } from '../repo/repository';
import { installPkgFile, installPackages } from './install';
import { loadConfig } from '../repo/config';
import { verCmp } from '../core/deps';
import type { RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';
import { confirm } from '../ui/prompt';
import { formatBytes } from '../ui/format';
import { humanSize, formatRate, formatETA } from '../ui/progress';
import { t } from '../i18n';

const LOCAL_DIR = '/var/lib/pacman-debian/local';

interface UpgradeTarget {
  name: string;
  oldVer: string;
  newVer: string;
  pkg: RepoPkg;
}

function listInstalledFromLocal(): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(LOCAL_DIR)) return result;
  for (const entry of fs.readdirSync(LOCAL_DIR)) {
    if (entry === 'by-name') continue;
    const descPath = path.join(LOCAL_DIR, entry, 'desc');
    if (!fs.existsSync(descPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(descPath, 'utf8'));
      if (data.name && data.version) result.set(data.name, data.version);
      else if (data.package && data.version) result.set(data.package, data.version);
    } catch {}
  }
  return result;
}

async function collectUpgradeCandidates(): Promise<UpgradeTarget[]> {
  const installed = listInstalledFromLocal();
  const targets: UpgradeTarget[] = [];

  // Filter IgnorePkg / IgnoreGroup
  const cfg = loadConfig();
  const ignoreSet = new Set(cfg.ignorePkg.map(s => s.toLowerCase()));

  // Batch resolve pacman-debian installed packages
  const repoPkgs = batchFindInRepo([...installed.keys()]);
  for (const [name, oldVer] of installed) {
    if (ignoreSet.has(name.toLowerCase())) continue;
    const pkg = repoPkgs.get(name);
    if (!pkg) continue;
    if (pkg.version && verCmp(pkg.version, oldVer) > 0) {
      targets.push({ name, oldVer, newVer: pkg.version, pkg });
    }
  }

  // Also check dpkg-installed packages against Debian repos
  const dpkg = readDpkgStatus();
  const seen = new Set([...installed.keys()].map(n => n.toLowerCase()));
  for (const [debName, debInfo] of dpkg) {
    const lc = debName.toLowerCase();
    if (ignoreSet.has(lc) || seen.has(lc)) continue;
    seen.add(lc);
    const rp = findInRepo(debName);
    if (!rp) continue;
    if (rp.version && verCmp(rp.version, debInfo.version) > 0) {
      targets.push({ name: debName, oldVer: debInfo.version, newVer: rp.version, pkg: rp });
    }
  }

  return targets;
}

export async function syncAndUpgrade(opts: InstallOptions = {}, force = false): Promise<void> {
  process.stdout.write(t('syncing_databases') + '\n');
  await syncRepos(force);
  await doUpgrade(opts);
}

async function doUpgrade(opts: InstallOptions = {}): Promise<void> {
  console.log(t('starting_upgrade'));
  const cfg = loadConfig();
  const ignoreSet = new Set(cfg.ignorePkg.map(s => s.toLowerCase()));
  const targets = await collectUpgradeCandidates();
  const filtered = targets.filter(t => !ignoreSet.has(t.name.toLowerCase()));
  const ignored = targets.length - filtered.length;

  if (filtered.length === 0) {
    if (ignored > 0) console.log(`  ${ignored} packages ignored by IgnorePkg`);
    else console.log(t('nothing_to_do'));
    return;
  }
  if (ignored > 0) console.log(`  ${ignored} packages ignored by IgnorePkg`);

  // Show packages and sizes (like official pacman)
  const totalDl = filtered.reduce((s, t_) => s + (t_.pkg.size || 0), 0);
  const totalInst = filtered.reduce((s, t_) => s + ((t_.pkg.installedSize || 0) * 1024), 0);

  if (cfg.verbosePkgLists) {
    const cols = process.stdout.columns || 80;
    const nameW = Math.max(20, Math.floor(cols * 0.3));
    const verO = Math.max(14, Math.floor(cols * 0.17));
    const verN = Math.max(14, Math.floor(cols * 0.17));
    console.log(t('packages_multi', String(filtered.length), ''));
    console.log(`  ${'Name'.padEnd(nameW)} ${'OldVer'.padEnd(verO)} ${'NewVer'.padEnd(verN)} ${'Size'.padStart(8)}`);
    console.log(`  ${'─'.repeat(nameW)} ${'─'.repeat(verO)} ${'─'.repeat(verN)} ${'─'.repeat(8)}`);
    for (const t_ of filtered) {
      const n = t_.name.length > nameW ? t_.name.slice(0, nameW - 3) + '...' : t_.name;
      const o = t_.oldVer.length > verO ? t_.oldVer.slice(0, verO - 3) + '...' : t_.oldVer;
      const v = t_.newVer.length > verN ? t_.newVer.slice(0, verN - 3) + '...' : t_.newVer;
      console.log(`  ${n.padEnd(nameW)} ${o.padEnd(verO)} ${v.padEnd(verN)} ${formatBytes(t_.pkg.size || 0).padStart(8)}`);
    }
  } else {
    console.log(t('packages_multi', String(filtered.length), filtered.map(t_ => `${t_.name} ${t_.oldVer} -> ${t_.newVer}`).join('  ')));
  }
  console.log('');
  console.log(t('total_download_size', formatBytes(totalDl).padStart(9)));
  console.log(t('total_installed_size', formatBytes(totalInst).padStart(9)));
  console.log('');

  if (!await confirm(t('confirm_proceed'))) { return; }

  if (opts.print) {
    for (const t_ of filtered) console.log(t('would_upgrade', `${t_.name} ${t_.oldVer} -> ${t_.newVer}`));
    return;
  }

  for (let i = 0; i < filtered.length; i++) {
    const t_ = filtered[i];
    process.stdout.write(t('progress_downloading', String(i + 1), String(filtered.length), t_.name) + '...\n');
    const rp = findInRepo(t_.name);
    if (!rp) { console.error(t('warn_not_found_in_repo', t_.name)); continue; }
    const localPath = await downloadPkg(rp);
    console.log(t('progress_checking_integrity', String(i + 1), String(filtered.length), ''));
    console.log(t('progress_loading_files', String(i + 1), String(filtered.length), ''));
    console.log(t('progress_upgrading', String(i + 1), String(filtered.length), t_.name));
    await installPkgFile(localPath, 'explicit', opts);
  }
}

export async function upgradeOnly(opts: InstallOptions = {}): Promise<void> {
  await doUpgrade(opts);
}
