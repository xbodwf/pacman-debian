#!/usr/bin/env node
import { addPackage, removePackage, getPackage, listPackageNames } from '../db/localdb';
import { readDpkgStatus, refreshDpkgProvides } from '../db/dpkg-compat';
import { addPaclink, removePaclink, writePaclinks, readPaclinks, parsePaclinkText } from '../core/paclinks';
import type { InstalledPackage } from '../core/types';
import { scopedT } from '../i18n';
import { color, setColorMode } from '../ui/colors';
import { execSync } from 'node:child_process';
import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
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
const CONFIG_FILE = '/etc/pacman-debian/paclink.conf';
const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/xbodwf/paclinks/main/paclinks.conf';
const DEFAULT_CACHE = '/var/cache/pacman-debian/paclinks.conf';

interface PaclinkConfig { color: 'always' | 'auto' | 'never'; server: string; cache: string; }

function loadPaclinkConfig(): PaclinkConfig {
  const config: PaclinkConfig = { color: 'auto', server: DEFAULT_SOURCE, cache: DEFAULT_CACHE };
  if (!fs.existsSync(CONFIG_FILE)) return config;
  for (const raw of fs.readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'color' && (value === 'always' || value === 'auto' || value === 'never')) config.color = value;
    else if (key === 'server') config.server = value;
    else if (key === 'cachedir') config.cache = path.join(value, 'paclinks.conf');
    else if (key === 'cachefile') config.cache = value;
  }
  return config;
}

function configureColors(): PaclinkConfig {
  const config = loadPaclinkConfig();
  setColorMode(config.color);
  return config;
}

function installedDebianNames(): Set<string> {
  return new Set(readDpkgStatus().keys());
}

function dependsOnVirt(virt: string): string | undefined {
  for (const entry of listPackageNames()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, entry, 'desc'), 'utf8'));
      if (pkg.repoType === 'link') continue;
      const deps = `${pkg.depends || ''} ${pkg['pre-depends'] || ''}`;
      if (deps.split(/[\s,|]+/).some((dep: string) => dep.replace(/[<>=].*$/, '') === virt)) return pkg.name;
    } catch {}
  }
  return undefined;
}

function sourceEntries(file: string): { virt: string; deb: string }[] {
  if (!fs.existsSync(file)) return [];
  return parsePaclinkText(fs.readFileSync(file, 'utf8'));
}

function downloadSource(url: string, destination: string, redirects = 0): Promise<void> {
  if (redirects > 5) return Promise.reject(new Error('too many redirects'));
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(parsed, { headers: { 'User-Agent': 'paclink/pacman-debian' } }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadSource(new URL(response.headers.location, parsed).toString(), destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${response.statusCode || 0}`));
        return;
      }
      const output = fs.createWriteStream(destination, { mode: 0o644 });
      response.pipe(output);
      output.on('finish', () => output.close(() => resolve()));
      output.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(120000, () => request.destroy(new Error('download timed out')));
  });
}

async function rebuildInstalledLinks(source: string, noconfirm: boolean): Promise<void> {
  const installed = installedDebianNames();
  const candidates = sourceEntries(source);
  const active = candidates.filter(e => installed.has(e.deb));
  const activeByVirt = new Map<string, { virt: string; deb: string }>();
  for (const entry of active) if (!activeByVirt.has(entry.virt)) activeByVirt.set(entry.virt, entry);
  const current = readPaclinks();
  const currentByVirt = new Map(current.map(e => [e.virt, e]));
  const removed = current.filter(e => !activeByVirt.has(e.virt));
  const changed = active.filter(e => currentByVirt.get(e.virt)?.deb !== e.deb);

  if (!noconfirm && (removed.length || changed.length)) {
    console.log(t('mapping_changes', removed.length, changed.length));
    if (!await confirm(t('confirm_changes'))) return;
  }

  for (const entry of removed) {
    console.warn(color.warn(t('mapping_removed', entry.virt, entry.deb)));
    const dependent = dependsOnVirt(entry.virt);
    if (dependent) console.warn(color.warn(t('mapping_depends', dependent, entry.virt)));
    const link = getPackage(entry.virt);
    if (link?.repoType === 'link') removePackage(entry.virt, link.version);
  }
  for (const entry of changed) {
    const existing = getPackage(entry.virt);
    if (existing?.repoType === 'link') removePackage(entry.virt, existing.version);
    const info = readDpkgStatus().get(entry.deb);
    if (!info) continue;
    addPackage({
      name: entry.virt, version: info.version || '0', architecture: info.architecture || process.arch,
      description: `Virtual package - links to Debian package ${entry.deb}`, provides: entry.virt,
      depends: entry.deb, installTime: Math.floor(Date.now() / 1000), reason: 'explicit', files: [], repoType: 'link',
    });
  }
  writePaclinks([...activeByVirt.values()]);
  await refreshDpkgProvides();
  console.log(activeByVirt.size ? t('mappings_active', activeByVirt.size) : t('mappings_none'));
}

async function syncSource(force: boolean): Promise<void> {
  const config = loadPaclinkConfig();
  const cache = config.cache;
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const tmp = `${cache}.tmp-${process.pid}`;
  await downloadSource(config.server, tmp);
  const entries = sourceEntries(tmp);
  if (!entries.length) { fs.unlinkSync(tmp); throw new Error(t('source_invalid')); }
  fs.renameSync(tmp, cache);
  console.log(t('source_downloaded', entries.length, cache));
}

async function syncOperation(flags: string, noconfirm: boolean): Promise<void> {
  const force = flags.includes('yy');
  const update = flags.includes('u');
  if (flags.includes('y')) await syncSource(force);
  if (!update) return;
  const config = loadPaclinkConfig();
  if (!fs.existsSync(config.cache)) throw new Error(t('source_missing'));
  await rebuildInstalledLinks(config.cache, noconfirm);
}

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
      const target = desc.link_target || desc.depends || '-';
      console.log(`${desc.name} ${desc.version}  → ${target}  (${desc.description || ''})`);
      found++;
    } catch {}
  }
  if (found === 0) console.log(t('no_links'));
}

interface MappingPackage { name: string; version: string; target: string; description?: string; }

function mappingPackages(): MappingPackage[] {
  const result: MappingPackage[] = [];
  for (const entry of listPackageNames()) {
    try {
      const desc = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, entry, 'desc'), 'utf8'));
      if (desc.repoType !== 'link') continue;
      result.push({ name: desc.name, version: desc.version || '0', target: desc.link_target || desc.depends || '?', description: desc.description });
    } catch {}
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function queryLinks(mode: string, target?: string): void {
  const packages = mappingPackages();
  if (mode === 'o') {
    const matches = packages.filter(pkg => pkg.target === target);
    if (!matches.length) { console.error(color.error(t('query_no_match', target || ''))); return; }
    console.log(t('query_provided_by', target || '', matches.map(pkg => color.pkg(pkg.name)).join('  ')));
    return;
  }
  let selected = packages;
  if (target && mode === 's') {
    const needle = target.toLowerCase();
    selected = packages.filter(pkg => `${pkg.name} ${pkg.target} ${pkg.description || ''}`.toLowerCase().includes(needle));
  } else if (target) {
    selected = packages.filter(pkg => pkg.name === target);
  }
  if (!selected.length) { console.error(color.error(target ? t('query_no_match', target) : t('query_no_packages'))); return; }
  if (mode === 'i') {
    for (const pkg of selected) {
      console.log(t('query_name', color.pkg(pkg.name)));
      console.log(t('query_version', color.title(pkg.version)));
      console.log(t('query_target', color.local(pkg.target)));
      console.log(t('query_provides', color.pkg(pkg.name)));
      console.log(t('query_reason', t('query_mapping')));
      console.log('');
    }
  } else if (mode === 'l') {
    for (const pkg of selected) console.log(t('query_link_file', color.pkg(pkg.name), color.local(pkg.target)));
  } else {
    for (const pkg of selected) console.log(`${color.pkg(pkg.name)} ${color.title(pkg.version)} ${color.local(pkg.target)}`);
  }
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
      const target = desc.link_target || desc.depends || '-';
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

  addPaclink(virtName, debPkg);
  addPackage(linkPkg);
  await refreshDpkgProvides();
  console.log(t('link_created', virtName, version, debPkg));
}

async function initLinks(noconfirm: boolean): Promise<void> {
  const dpkg = readDpkgStatus();

  // Read mapping source from config file
  const sourceFile = '/etc/pacman-debian/paclinks.conf';
  let commonMappings: [string, string][] = [];

  if (!fs.existsSync(sourceFile)) {
    console.log(t('source_file_missing', sourceFile));
    console.log(t('source_file_example'));
    return;
  }

  const text = fs.readFileSync(sourceFile, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [virt, ...rest] = t.split(/\s+/);
    if (virt && rest.length > 0) commonMappings.push([virt, rest.join(' ')]);
  }

  const created: [string, string][] = [];
  for (const [virt, deb] of commonMappings) {
    const debInfo = dpkg.get(deb);
    if (!debInfo) continue;
    created.push([virt, deb]);
  }

  if (created.length === 0) {
    console.log(t('init_none'));
    return;
  }

  console.log(t('init_found', created.length));
  for (const [virt, deb] of created.slice(0, 10)) console.log(`  ${color.pkg(virt)} ← ${color.local(deb)}`);
  if (created.length > 10) console.log(t('init_more', created.length - 10));

  if (!noconfirm) {
    if (!await confirm(t('confirm_init', String(created.length)) + ' ' + t('confirm_prompt'))) {
      console.log(t('cancelled'));
      return;
    }
  }

  for (const [virt, deb] of created) {
    const existing = getPackage(virt);
    if (!existing || existing.repoType !== 'link') {
      const debInfo = dpkg.get(deb)!;
      const linkPkg: InstalledPackage = {
        name: virt, version: debInfo.version || '0',
        architecture: debInfo.architecture || process.arch,
        description: `Virtual package - links to Debian package ${deb}`,
        provides: virt, depends: deb,
        installTime: Math.floor(Date.now() / 1000),
        reason: 'explicit', files: [], repoType: 'link',
      };
      addPackage(linkPkg);
    }
  }
  writePaclinks(created.map(([virt, deb]) => ({ virt, deb })));
  console.log(t('init_created', created.length));
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

  removePaclink(name);
  removePackage(name, pkg.version);
  await refreshDpkgProvides();
  console.log(t('link_removed', name, target));

  if (!noconfirm) {
    if (await confirm(t('confirm_pacman_remove', name) + ' [y/N] ')) {
      try {
        execSync(`pacman -R --noconfirm "${name}" 2>/dev/null`, { stdio: 'inherit', timeout: 60000 });
      } catch {}
    }
    if (target !== '?' && await confirm(t('confirm_apt_remove', target) + ' [y/N] ')) {
      try {
        execSync(`apt-get remove -y "${target}" 2>/dev/null`, { stdio: 'inherit', timeout: 120000 });
        console.log(t('apt_removed', target));
      } catch (e: any) {
        console.error(t('apt_remove_failed', target, e.message));
      }
    }
  }
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
  configureColors();

  if (op === '-Sy' || op === '-Syy' || op === '-Su' || op === '-Syu' || op === '-Syyu') {
    needRoot('synchronize paclink mappings');
    await syncOperation(op.slice(1), noconfirm);
    return;
  }

  if (op === '-U') {
    if (rest.length !== 1) { console.error(t('usage_upgrade')); process.exit(1); }
    needRoot('install paclink mappings');
    const file = path.resolve(rest[0]);
    if (!fs.existsSync(file) || !sourceEntries(file).length) {
      console.error(color.error(t('source_invalid_file', file)));
      process.exit(1);
    }
    await rebuildInstalledLinks(file, noconfirm);
    return;
  }

  if (op === '-Q' || op === '-Qi' || op === '-Ql' || op === '-Qs' || op === '-Qo') {
    const mode = op === '-Q' ? 'q' : op.slice(2);
    const validArgs = mode === 'q' || mode === 'i' || mode === 'l'
      ? rest.length <= 1
      : rest.length === 1;
    if (!validArgs) { console.error(t('usage_query')); process.exit(1); }
    queryLinks(mode, rest[0]);
    return;
  }

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

    case '-I':
      needRoot('initialize paclink mappings');
      await initLinks(noconfirm);
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
