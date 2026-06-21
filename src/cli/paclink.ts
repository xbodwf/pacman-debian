#!/usr/bin/env node
import { addPackage, removePackage, getPackage, listPackageNames } from '../db/localdb';
import { readDpkgStatus } from '../db/dpkg-compat';
import type { InstalledPackage } from '../core/types';
import { scopedT } from '../i18n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const t = scopedT('paclink');

function confirm(prompt: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '' || a === 'y' || a === 'yes') resolve(true);
      else resolve(false);
    });
  });
}

const LOCAL_DIR = '/var/lib/pacman-debian/local';

function help(exit = 0): void {
  const v = '1.0';
  console.log(t('help_text', v));
  process.exit(exit);
}

function listLinks(): void {
  const names = listPackageNames();
  let found = 0;
  for (const entry of names) {
    const dir = path.join(LOCAL_DIR, entry);
    const fp = path.join(dir, 'desc');
    if (!fs.existsSync(fp)) continue;
    try {
      const desc = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (desc.repoType !== 'link') continue;
      const target = desc.link_target || '-';
      console.log(`${desc.name} ${desc.version}  → ${target}  (${desc.description || ''})`);
      found++;
    } catch {}
  }
  if (found === 0) console.log(t('no_links'));
}

function searchLinks(pattern: string): void {
  const lower = pattern.toLowerCase();
  const names = listPackageNames();
  let found = 0;
  for (const entry of names) {
    const dir = path.join(LOCAL_DIR, entry);
    const fp = path.join(dir, 'desc');
    if (!fs.existsSync(fp)) continue;
    try {
      const desc = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (desc.repoType !== 'link') continue;
      if (!desc.name.toLowerCase().includes(lower) &&
          !(desc.link_target || '').toLowerCase().includes(lower)) continue;
      const target = desc.link_target || '-';
      console.log(`${desc.name} ${desc.version}  → ${target}  (${desc.description || ''})`);
      found++;
    } catch {}
  }
  if (found === 0) console.log(t('no_link_match', pattern));
}

function showLinkInfo(name: string): void {
  const pkg = getPackage(name);
  if (!pkg || pkg.repoType !== 'link') {
    console.error(t('link_not_found', name));
    process.exit(1);
  }
  const target = pkg.description?.replace(/^Virtual package - links to Debian package /, '') || '-';
  console.log(t('link_info_name', pkg.name));
  console.log(t('link_info_provides', pkg.provides || pkg.name));
  console.log(t('link_info_version', pkg.version));
  console.log(t('link_info_target', target));
  console.log(t('link_info_desc', pkg.description || '-'));
  console.log(t('link_info_time', new Date((pkg.installTime || 0) * 1000).toISOString()));
}

async function createLink(debPkg: string, virtName: string, noconfirm: boolean): Promise<void> {
  if (!debPkg || !virtName) {
    console.error(t('need_virt_name'));
    process.exit(1);
  }

  const existing = getPackage(virtName);
  if (existing && existing.repoType === 'link') {
    const oldTarget = existing.description?.replace(/^Virtual package - links to Debian package /, '') || '?';
    if (oldTarget === debPkg) {
      console.log(t('link_skipped', virtName, debPkg));
      return;
    }
    if (!noconfirm) {
      if (!await confirm(t('confirm_overwrite', virtName, oldTarget, debPkg) + ' ' + t('confirm_prompt'))) {
        console.log(t('cancelled'));
        process.exit(0);
      }
    }
    removePackage(virtName, existing.version);
    console.log(t('link_overwritten', virtName, debPkg, oldTarget));
  }

  const dpkg = readDpkgStatus();
  const debInfo = dpkg.get(debPkg);
  if (!debInfo) {
    console.error(t('deb_not_installed', debPkg));
    console.error(t('deb_not_installed_hint', debPkg));
    process.exit(1);
  }

  const version = debInfo.version || '0';
  const arch = debInfo.architecture || process.arch;

  if (!noconfirm) {
    if (!await confirm(t('confirm_create', virtName, debPkg, version) + ' ' + t('confirm_prompt'))) {
      console.log(t('cancelled'));
      process.exit(0);
    }
  }

  const linkPkg: InstalledPackage = {
    name: virtName,
    version,
    architecture: arch,
    description: `Virtual package - links to Debian package ${debPkg}`,
    provides: virtName,
    depends: debPkg,
    installTime: Math.floor(Date.now() / 1000),
    reason: 'explicit',
    files: [],
    repoType: 'link',
  };

  addPackage(linkPkg);
  console.log(t('link_created', virtName, version, debPkg));
}

async function removeLink(name: string, noconfirm: boolean): Promise<void> {
  const pkg = getPackage(name);
  if (!pkg || pkg.repoType !== 'link') {
    console.error(t('link_not_found', name));
    process.exit(1);
  }

  const target = pkg.description?.replace(/^Virtual package - links to Debian package /, '') || '?';

  if (!noconfirm) {
    if (!await confirm(t('confirm_remove', name, target) + ' ' + t('confirm_prompt'))) {
      console.log(t('cancelled'));
      process.exit(0);
    }
  }

  removePackage(name, pkg.version);
  console.log(t('link_removed', name, target));
}

function needRoot(msg: string): void {
  if (!process.getuid || process.getuid() === 0) return;
  console.error(t('error_need_root', msg));
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') help();

  const noconfirm = args.includes('--noconfirm');
  const cleanArgs = args.filter(a => a !== '--noconfirm');

  const op = cleanArgs[0];
  const rest = cleanArgs.slice(1);

  switch (op) {
    case '-L':
      if (rest.length === 0) {
        listLinks();
      } else if (rest.length === 1) {
        showLinkInfo(rest[0]);
      } else {
        console.error(t('usage_L'));
        process.exit(1);
      }
      break;

    case '-Ls':
      if (rest.length === 1) {
        searchLinks(rest[0]);
      } else {
        console.error(t('usage_Ls'));
        process.exit(1);
      }
      break;

    case '-Ln':
      if (rest.length === 2) {
        needRoot(t('need_root_create'));
        await createLink(rest[0], rest[1], noconfirm);
      } else {
        console.error(t('usage_Ln'));
        process.exit(1);
      }
      break;

    case '-Li':
      if (rest.length !== 1) {
        console.error(t('usage_Li'));
        process.exit(1);
      }
      showLinkInfo(rest[0]);
      break;

    case '-R':
      if (rest.length !== 1) {
        console.error(t('usage_R'));
        process.exit(1);
      }
      needRoot(t('need_root_remove'));
      await removeLink(rest[0], noconfirm);
      break;

    default:
      console.error(t('unknown_op', op));
      console.error(`${t('usage')} paclink -Ls <debPkg> <virtName>`);
      process.exit(1);
  }
}

main().catch(e => {
  console.error(t('error_prefix', e.message));
  process.exit(1);
});
