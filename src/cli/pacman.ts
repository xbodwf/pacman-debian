import { installPkg, installPackages } from '../ops/install';
import { removeByName } from '../ops/remove';
import { listInstalled, showInfo, queryFile, listFiles, listExplicit, listDeps, listOrphans, checkIntegrity } from '../ops/query';
import { syncAndUpgrade, upgradeOnly } from '../ops/upgrade';
import { syncRepos, searchRepo, findInRepo, downloadPkg, getRepoCache } from '../repo/repository';
import { initDb, loadDatabase, saveDatabase, getPackage } from '../db/database';
import { readDpkgStatus } from '../db/dpkg-compat';
import { setNoConfirm } from '../ui/prompt';
import { t as t_ } from '../i18n';
import * as fs from 'node:fs';
import pkg from '../../package.json';
import type { InstallOptions } from '../core/options';

const CACHE = '/var/cache/pacman-debian/pkg';
const PCACHE = '/var/cache/pacman-debian/packages';
const VERSION = pkg.version;

function help(): void {
  console.log(t_('help_text'));
}

function cleanCache(all: boolean): void {
  if (fs.existsSync(CACHE)) { fs.rmSync(CACHE, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true }); }
  if (all && fs.existsSync(PCACHE)) { fs.rmSync(PCACHE, { recursive: true }); }
  console.log(all ? ':: cache cleaned' : ':: package cache cleaned');
}

function listRepoContents(repoName?: string): void {
  const all = getRepoCache();
  for (const p of all) {
    if (!repoName || p.repo === repoName) console.log(`${p.repo}/${p.package} ${p.version}`);
  }
}

function checkDeps(packages: string[]): void {
  const dpkg = readDpkgStatus();
  for (const name of packages) {
    const rp = findInRepo(name);
    if (!rp) { console.log(`${name}        not found`); continue; }
    console.log(`${name}        ${dpkg.has(name) ? 'installed' : 'missing'}`);
  }
}

function markAsDep(packages: string[]): void {
  initDb();
  const db = loadDatabase();
  for (const name of packages) {
    const p = getPackage(db, name);
    if (!p) { console.error(`error: '${name}' is not installed`); continue; }
    p.reason = 'dependency';
    saveDatabase(db);
    console.log(`  ${name} marked as dependency`);
  }
}

function markAsExplicit(packages: string[]): void {
  initDb();
  const db = loadDatabase();
  for (const name of packages) {
    const p = getPackage(db, name);
    if (!p) { console.error(`error: '${name}' is not installed`); continue; }
    p.reason = 'explicit';
    saveDatabase(db);
    console.log(`  ${name} marked as explicitly installed`);
  }
}

function extractGlobalFlags(args: string[]): { operands: string[]; noconfirm: boolean; needed: boolean; noscriptlet: boolean; print: boolean } {
  let noconfirm = false, needed = false, noscriptlet = false, print = false;
  const operands: string[] = [];
  for (const a of args) {
    switch (a) {
      case '--noconfirm': noconfirm = true; break;
      case '--confirm': noconfirm = false; break;
      case '--needed': needed = true; break;
      case '--noscriptlet': noscriptlet = true; break;
      case '--print': print = true; break;
      case '--noprogressbar': break;
      default: operands.push(a);
    }
  }
  return { operands, noconfirm, needed, noscriptlet, print };
}

export async function parseArgs(args: string[]): Promise<void> {
  if (args.length === 0) { console.error(t_('error_no_operation')); help(); return; }

  const { operands, noconfirm, needed, noscriptlet, print } = extractGlobalFlags(args);
  setNoConfirm(noconfirm);

  if (operands.length === 0) { console.error(t_('error_no_operation')); help(); return; }

  const raw = operands[0];
  const rest = operands.slice(1);
  const opts: InstallOptions = { needed, noscriptlet, print };

  // Long-form operations
  if (raw === '--help' || raw === '-h') { help(); return; }
  if (raw === '--version' || raw === '-V') { console.log(t_('version_string', VERSION)); return; }
  if (raw === '--sync') {
    const asdeps = rest.includes('--asdeps');
    const targets = rest.filter(a => !a.startsWith('-'));
    if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
    await installPackages(targets, { ...opts, asdeps });
    return;
  }
  if (raw === '--upgrade') {
    const targets = rest.filter(a => !a.startsWith('-'));
    if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
    for (const t of targets) await installPkg(t, opts);
    return;
  }
  if (raw === '--remove') {
    const targets = rest.filter(a => !a.startsWith('-'));
    if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
    for (const n of targets) await removeByName(n, { recursive: false });
    return;
  }
  if (raw === '--query') {
    if (rest.length === 0) listInstalled();
    else showInfo(rest[0], false);
    return;
  }
  if (raw === '--database') {
    const asdeps = rest.includes('--asdeps');
    const asexplicit = rest.includes('--asexplicit');
    const targets = rest.filter(a => !a.startsWith('-'));
    if (asdeps) markAsDep(targets);
    if (asexplicit) markAsExplicit(targets);
    return;
  }
  if (raw === '--files') {
    if (rest[0] === '-y' || rest[0] === 'y') { console.log(':: file database not maintained'); return; }
    if (rest.length > 0) queryFile(rest[0]);
    return;
  }
  if (raw === '--deptest') {
    checkDeps(rest);
    return;
  }

  // Short-form
  if (!raw.startsWith('-')) { console.error(`error: unknown operation '${raw}'`); process.exit(1); }
  const op = raw[1];
  const flags = raw.slice(2);

  if (op === 'h') { help(); return; }
  if (op === 'V') { console.log(t_('version_string', VERSION)); return; }

  if (op === 'S' || op === 'U') {
    const doRefresh = flags.includes('y');
    const forceRefresh = flags.includes('yy');
    const doUpgrade = flags.includes('u');
    const doSearch = flags.includes('s');
    const doInfo = flags.includes('i');
    const doClean = flags.split('').filter(c => c === 'c').length === 2;
    const doSingleClean = flags.includes('c') && !doClean;
    const doDownload = flags.includes('w');
    const doPrint = flags.includes('p');
    const doList = flags.includes('l');

    if (doSearch) {
      if (rest.length === 0) { console.error(t_('error_no_search_term')); return; }
      const results = searchRepo(rest[0]);
      if (results.length === 0) { console.log(t_('no_pkg_found_matching', rest[0])); return; }
      for (let i = 0; i < Math.min(results.length, 50); i++) {
        const p = results[i];
        console.log(t_('search_result_line', p.repo, p.package, p.version));
        if (p.description) console.log(t_('search_result_desc', p.description));
      }
      if (results.length > 50) console.log(t_('search_more_results', String(results.length - 50)));
      return;
    }
    if (doInfo) {
      if (rest.length === 0) { console.error(t_('error_no_pkg_name')); return; }
      showInfo(rest[0], true);
      return;
    }
    if (doList) { listRepoContents(rest[0]); return; }
    if (doSingleClean) { cleanCache(false); return; }
    if (doClean) { cleanCache(true); return; }
    if (doDownload) {
      for (const t of rest) {
        const p = findInRepo(t);
        if (p) console.log(t_('pkg_downloaded', t));
        else console.log(t_('error_not_found', t));
      }
      return;
    }
    if (doPrint) {
      for (const t of rest) console.log(t_('would_install', t));
      return;
    }
    if (doRefresh && doUpgrade) { await syncAndUpgrade(opts); return; }
    if (doRefresh) {
      console.log(t_('syncing_databases'));
      await syncRepos(forceRefresh);
      return;
    }
    if (doUpgrade) { await upgradeOnly(opts); return; }

    // -U: install local file
    if (op === 'U') {
      const targets = rest.filter(a => !a.startsWith('-'));
      if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
      for (const t of targets) await installPkg(t, opts);
      return;
    }

    // -S: install from repos
    const asdeps = rest.includes('--asdeps');
    const targets = rest.filter(a => !a.startsWith('-'));
    if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
    await installPackages(targets, { ...opts, asdeps });
    return;
  }

  if (op === 'R') {
    const targets = rest.filter(a => !a.startsWith('-'));
    if (targets.length === 0) { console.error(t_('error_no_targets')); return; }
    const flags = raw.slice(2);
    const recursive = flags.includes('s');
    const cascade = flags.includes('c');
    const nodeps = flags.includes('d');
    const doPrint = flags.includes('p');
    for (const n of targets) await removeByName(n, { recursive, cascade, nodeps, print: doPrint });
    return;
  }

  if (op === 'Q') {
    if (rest.length === 0) { listInstalled(); return; }
    const qflags = flags || rest[0];
    if (qflags.startsWith('-')) {
      const q = qflags.slice(1);
      if (q === 'i') { showInfo(rest[1], false); return; }
      if (q === 'o') { if (rest[1]) queryFile(rest[1]); else console.error(t_('error_no_file')); return; }
      if (q === 'l') { if (rest[1]) listFiles(rest[1]); else console.error(t_('error_no_pkg_name')); return; }
      if (q === 's') { if (rest[1]) { listInstalled(rest[1]); return; } listInstalled(); return; }
      if (q === 'e') { listExplicit(); return; }
      if (q === 'd') { listDeps(); return; }
      if (q === 'dt') { listOrphans(); return; }
      if (q === 'k') { checkIntegrity(); return; }
      if (q === 'q') { listInstalled(); return; }
      if (q.length > 1 && q[0] === 'k') { checkIntegrity(q.slice(1)); return; }
      console.error(t_('error_unknown_option', q));
      return;
    }
    showInfo(rest[0], false);
    return;
  }

  if (op === 'Q') {
    if (flags === '') { listInstalled(); return; }
    if (flags.includes('i')) {
      if (rest.length === 0) { console.error(t_('error_no_pkg_name')); return; }
      showInfo(rest[0], false);
      return;
    }
    if (flags.includes('o')) {
      if (rest.length === 0) { console.error(t_('error_no_file')); return; }
      queryFile(rest[0]);
      return;
    }
    if (flags.includes('l')) {
      if (rest.length === 0) { console.error(t_('error_no_pkg_name')); return; }
      listFiles(rest[0]);
      return;
    }
    if (flags.includes('s')) { listInstalled(rest[0]); return; }

    if ((flags.includes('d') && flags.includes('t')) || flags.includes('td') || flags.includes('dt')) { listOrphans(); return; }
    if (flags.includes('e') && !flags.includes('d') && !flags.includes('t')) { listExplicit(); return; }
    if (flags.includes('d') && !flags.includes('e') && !flags.includes('t')) { listDeps(); return; }
    if (flags.includes('k')) { checkIntegrity(rest[0]); return; }

    console.error(`error: unknown option '-Q${flags}'`);
    process.exit(1);
  }

  if (op === 'D') {
    const asdeps = rest.includes('--asdeps');
    const asexplicit = rest.includes('--asexplicit');
    const targets = rest.filter(a => !a.startsWith('-'));
    if (asdeps) markAsDep(targets);
    if (asexplicit) markAsExplicit(targets);
    return;
  }

  if (op === 'T') { checkDeps(rest); return; }

  if (op === 'F') {
    if (flags.includes('y')) { console.log(':: file database not maintained'); return; }
    if (rest.length > 0) queryFile(rest[0]);
    return;
  }

  console.error(`error: unknown operation '-${op}'`);
  process.exit(1);
}
