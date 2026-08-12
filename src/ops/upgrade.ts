import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDpkgStatus } from '../db/dpkg-compat';
import { syncRepos, findInRepo, findInRepoScoped, findInRepoVersioned, batchFindInRepo } from '../repo/repository';
import { installPackages } from './install';
import { loadConfig } from '../repo/config';
import { verCmp } from '../core/deps';
import type { RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';
import { confirm } from '../ui/prompt';
import { formatBytes } from '../ui/format';
import { t } from '../i18n';
import { color } from '../ui/colors';
import { renderTable } from '../ui/table';

const LOCAL_DIR = '/var/lib/pacman-debian/local';

interface UpgradeTarget {
  name: string;
  oldVer: string;
  newVer: string;
  pkg: RepoPkg;
  oldInstalledSize: number;
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

async function collectUpgradeCandidates(): Promise<{ targets: UpgradeTarget[]; warnings: string[] }> {
  const installed = listInstalledFromLocal();
  const targets: UpgradeTarget[] = [];
  const warnings: string[] = [];

  // Filter IgnorePkg / IgnoreGroup
  const cfg = loadConfig();
  const ignoreSet = new Set(cfg.ignorePkg.map(s => s.toLowerCase()));

  // Build old installed size map from local db
  const oldSizes = new Map<string, number>();
  const localDir = '/var/lib/pacman-debian/local';
  if (fs.existsSync(localDir)) {
    for (const entry of fs.readdirSync(localDir)) {
      if (entry === 'by-name') continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(localDir, entry, 'desc'), 'utf8'));
        if (d.name) oldSizes.set(d.name, d.installedSize || 0);
      } catch {}
    }
  }

  // Batch resolve pacman-debian installed packages
  const repoPkgs = batchFindInRepo([...installed.keys()]);
  for (const [name, oldVer] of installed) {
    if (ignoreSet.has(name.toLowerCase())) continue;
    const pkg = repoPkgs.get(name);
    if (!pkg || !pkg.version) continue;
    const cmp = verCmp(pkg.version, oldVer);
    if (cmp > 0) {
      targets.push({ name, oldVer, newVer: pkg.version, pkg, oldInstalledSize: oldSizes.get(name) || 0 });
    } else if (cmp < 0) {
      warnings.push(t('local_newer', name, oldVer, pkg.repo || pkg.repoType || '?', pkg.version));
    }
  }

  // Also check dpkg-installed packages against Debian repos
  const dpkg = readDpkgStatus();
  for (const [name, info] of dpkg) {
    if (!oldSizes.has(name) && info.installedSize) oldSizes.set(name, info.installedSize);
  }
  const dpkgOnly = [...dpkg.keys()].filter(name => !installed.has(name));
  const dpkgRepoPkgs = batchFindInRepo(dpkgOnly);
  const seen = new Set([...installed.keys()].map(n => n.toLowerCase()));
  for (const [debName, debInfo] of dpkg) {
    const lc = debName.toLowerCase();
    if (ignoreSet.has(lc) || seen.has(lc)) continue;
    seen.add(lc);
    const rp = dpkgRepoPkgs.get(debName);
    if (!rp || !rp.version) continue;
    const cmp = verCmp(rp.version, debInfo.version);
    if (cmp > 0) {
      targets.push({ name: debName, oldVer: debInfo.version, newVer: rp.version, pkg: rp, oldInstalledSize: debInfo.installedSize || 0 });
    } else if (cmp < 0) {
      warnings.push(t('local_newer', debName, debInfo.version, rp.repo || rp.repoType || '?', rp.version));
    }
  }

  return { targets, warnings };
}

export async function syncAndUpgrade(opts: InstallOptions = {}, force = false, extraTargets: string[] = []): Promise<void> {
  process.stdout.write(t('syncing_databases') + '\n');
  await syncRepos(force);
  await doUpgrade(opts, extraTargets);
}

async function doUpgrade(opts: InstallOptions = {}, extraTargets: string[] = []): Promise<void> {
  console.log(t('starting_upgrade'));
  const cfg = loadConfig();
  const ignoreSet = new Set(cfg.ignorePkg.map(s => s.toLowerCase()));
  const { targets: upgradeTargets, warnings } = await collectUpgradeCandidates();
  for (const w of warnings) console.log(color.warn(t('warn_prefix', w)));
  const explicit = extraTargets.map(target => {
    const slash = target.indexOf('/');
    const repo = slash > 0 ? target.slice(0, slash) : undefined;
    const requested = slash > 0 ? target.slice(slash + 1) : target;
    const eq = requested.indexOf('=');
    const name = eq >= 0 ? requested.slice(0, eq) : requested;
    const version = eq >= 0 ? requested.slice(eq + 1) : undefined;
    const pkg = version ? findInRepoVersioned(name, version, repo) : (repo ? findInRepoScoped(repo, name) : findInRepo(name));
    return pkg ? { name: pkg.package, oldVer: '', newVer: pkg.version, pkg, oldInstalledSize: 0 } : undefined;
  }).filter((target): target is UpgradeTarget => !!target);
  const byName = new Map<string, UpgradeTarget>();
  for (const target of [...upgradeTargets, ...explicit]) byName.set(target.name.toLowerCase(), target);
  const filtered = [...byName.values()].filter(t => !ignoreSet.has(t.name.toLowerCase()));
  const ignored = upgradeTargets.length - filtered.length;

  if (filtered.length === 0) {
     if (ignored > 0) console.log(`  ${color.warn(`${ignored} packages ignored by IgnorePkg`)}`);
    else console.log(t('nothing_to_do'));
    return;
  }
   if (ignored > 0) console.log(`  ${color.warn(`${ignored} packages ignored by IgnorePkg`)}`);

  // Show packages and sizes (like official pacman)
  const totalDl = filtered.reduce((s, t_) => s + (t_.pkg.size || 0), 0);
  const totalInst = filtered.reduce((s, t_) => s + ((t_.pkg.installedSize || 0) * 1024), 0);
  const totalOld = filtered.reduce((s, t_) => s + (t_.oldInstalledSize * 1024), 0);

  if (cfg.verbosePkgLists) {
    const header = [
      { title: t('table_header', String(filtered.length)) },
      { title: t('table_old_version') },
      { title: t('table_new_version') },
      { title: t('table_net_change'), right: true },
      { title: t('table_download_size'), right: true },
    ];
    const rows = filtered.map(t_ => [
      `${color.repo(t_.pkg.repo || '')}/${color.pkg(t_.name)}`,
      color.muted(t_.oldVer),
      color.ok(t_.newVer),
      color.size(formatBytes(((t_.pkg.installedSize || 0) - t_.oldInstalledSize) * 1024)),
      color.size(formatBytes(t_.pkg.size || 0)),
    ]);
    console.log(renderTable(header, rows));
  } else {
     console.log(t('packages_multi', String(filtered.length), filtered.map(t_ => `${color.pkg(t_.name)} ${color.muted(t_.oldVer)} -> ${color.ok(t_.newVer)}`).join('  ')));
  }
  console.log('');
  console.log(color.title(t('total_download_size', formatBytes(totalDl).padStart(9))));
  console.log(color.title(t('total_installed_size', formatBytes(totalInst).padStart(9))));
  if (totalInst > 0 && totalOld > 0) {
    console.log(color.title(t('total_net_upgrade', formatBytes(totalInst - totalOld).padStart(9))));
  }
  console.log('');

  if (!await confirm(opts.downloadonly ? t('confirm_download') : t('confirm_proceed'))) { return; }

  if (opts.print) {
    for (const t_ of filtered) console.log(t('would_upgrade', `${t_.name} ${t_.oldVer} -> ${t_.newVer}`));
    return;
  }

  // Use the same transaction as -S so upgrades download concurrently, perform
  // all checks before modifying the system, and share progress reporting.
  await installPackages(filtered.map(t_ => `${t_.pkg.repo}/${t_.name}=${t_.newVer}`), {
    ...opts,
    confirmed: true,
    skipSummary: true,
    skipDependencyResolution: true,
    preparedPackages: filtered.map(t_ => t_.pkg),
  });
}

export async function upgradeOnly(opts: InstallOptions = {}): Promise<void> {
  await doUpgrade(opts);
}
