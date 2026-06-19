import { readDpkgStatus } from '../db/dpkg-compat';
import { syncRepos, findInRepo, downloadPkg } from '../repo/repository';
import { installDeb, installPkgFile, installPackages, type InstallOptions } from './install';
import type { RepoPkg } from '../core/types';
import { confirm } from '../ui/prompt';
import { formatBytes } from '../ui/format';
import { t } from '../i18n';

export async function syncAndUpgrade(opts: InstallOptions = {}, force = false): Promise<void> {
  console.log(t('syncing_databases'));
  await syncRepos(force);
  await doUpgrade(opts);
}

async function doUpgrade(opts: InstallOptions = {}): Promise<void> {
  console.log('\n:: Starting full system upgrade...');
  const targets = await collectUpgradeCandidates();
  if (targets.length === 0) { console.log(' there is nothing to do\n'); return; }
  console.log(`\nPackages (${targets.length}):`);
  for (const t of targets) console.log(`  ${t.name} ${t.oldVer} -> ${t.newVer}`);
  console.log('');
  if (!await confirm(':: Proceed with upgrade?')) { return; }

  if (opts.print) {
    for (const t of targets) console.log(`  would upgrade: ${t.name} ${t.oldVer} -> ${t.newVer}`);
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    console.log(`(${i + 1}/${targets.length}) downloading ${t.name}...`);
    const rp = findInRepo(t.name);
    if (!rp) { console.error(`  WARNING: ${t.name} not found in repo`); continue; }
    const localPath = await downloadPkg(rp);
    console.log(`(${i + 1}/${targets.length}) checking package integrity...`);
    console.log(`(${i + 1}/${targets.length}) loading package files...`);
    console.log(`(${i + 1}/${targets.length}) upgrading ${t.name}...`);
    await installPkgFile(localPath, 'explicit', opts);
  }
}

export async function upgradeOnly(opts: InstallOptions = {}): Promise<void> {
  await doUpgrade(opts);
}
