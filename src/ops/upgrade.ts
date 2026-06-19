import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDpkgStatus } from '../db/dpkg-compat';
import { syncRepos, findInRepo, downloadPkg } from '../repo/repository';
import { installPkgFile, installPackages } from './install';
import type { RepoPkg } from '../core/types';
import type { InstallOptions } from '../core/options';
import { confirm } from '../ui/prompt';
import { formatBytes } from '../ui/format';
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

  for (const [name, oldVer] of installed) {
    const pkg = findInRepo(name);
    if (!pkg) continue;
    const newVer = pkg.version;
    if (newVer && newVer !== oldVer) {
      targets.push({ name, oldVer, newVer, pkg });
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
  const targets = await collectUpgradeCandidates();
  if (targets.length === 0) { console.log(t('nothing_to_do')); return; }
  console.log(`\nPackages (${targets.length}):`);
  for (const t_ of targets) console.log(`  ${t_.name} ${t_.oldVer} -> ${t_.newVer}`);
  console.log('');
  if (!await confirm(':: Proceed with upgrade?')) { return; }

  if (opts.print) {
    for (const t_ of targets) console.log(`  would upgrade: ${t_.name} ${t_.oldVer} -> ${t_.newVer}`);
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    const t_ = targets[i];
    console.log(`(${i + 1}/${targets.length}) downloading ${t_.name}...`);
    const rp = findInRepo(t_.name);
    if (!rp) { console.error(`  WARNING: ${t_.name} not found in repo`); continue; }
    const localPath = await downloadPkg(rp);
    console.log(`(${i + 1}/${targets.length}) checking package integrity...`);
    console.log(`(${i + 1}/${targets.length}) loading package files...`);
    console.log(`(${i + 1}/${targets.length}) upgrading ${t_.name}...`);
    await installPkgFile(localPath, 'explicit', opts);
  }
}

export async function upgradeOnly(opts: InstallOptions = {}): Promise<void> {
  await doUpgrade(opts);
}
