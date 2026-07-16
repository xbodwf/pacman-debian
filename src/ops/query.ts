import * as fs from 'node:fs';
import * as localdb from '../db/localdb';
import { loadDatabase } from '../db/database';
import { readDpkgStatus } from '../db/dpkg-compat';
import { searchRepo, findInRepo } from '../repo/repository';
import { t } from '../i18n';

export function listInstalled(filter?: string, quiet = false): void {
  const dpkg = readDpkgStatus();
  let pkgs = [...dpkg.values()];
  if (filter) {
    const lq = filter.toLowerCase();
    pkgs = pkgs.filter(p => p.package.toLowerCase().includes(lq) || (p.description && p.description.toLowerCase().includes(lq)));
  }
  if (pkgs.length === 0) { console.log(t('no_pkgs_installed')); return; }
  pkgs.sort((a, b) => a.package.localeCompare(b.package));
  const nameW = Math.min(Math.max(...pkgs.map(p => p.package.length)) + 2, 30);
  for (const p of pkgs) {
    if (quiet) { console.log(p.package); continue; }
    const name = p.package.length > nameW ? p.package : p.package.padEnd(nameW);
    console.log(`${name} ${p.version}`);
  }
}

export function listExplicit(): void {
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'explicit');
  const nameW = Math.min(Math.max(...pkgs.map(p => p.name.length)) + 2, 30);
  for (const p of pkgs) console.log(`${p.name.padEnd(nameW)}${p.version}`);
}

export function listDeps(): void {
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'dependency');
  const nameW = Math.min(Math.max(...pkgs.map(p => p.name.length)) + 2, 30);
  for (const p of pkgs) console.log(`${p.name.padEnd(nameW)}${p.version}`);
}

export function listOrphans(): void {
  const needed = new Set<string>();
  for (const p of localdb.getAllPackages()) {
    const deps = (p.depends || '').split(',').map(s => s.trim().split(/\s/)[0]).filter(Boolean);
    for (const d of deps) needed.add(d);
  }
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'dependency' && !needed.has(p.name));
  const nameW = Math.min(Math.max(...pkgs.map(p => p.name.length)) + 2, 30);
  for (const p of pkgs) console.log(`${p.name.padEnd(nameW)}${p.version}`);
}

export function checkIntegrity(name?: string): void {
  if (name) {
    const p = localdb.getPackage(name);
    if (!p) { console.error(t('error_not_installed', name)); return; }
    let missing = 0, empty = 0;
    for (const f of p.files) {
      if (!fs.existsSync(f)) { missing++; continue; }
      try { if (fs.statSync(f).size === 0) empty++; } catch {}
    }
    const total = missing + empty;
    console.log(total === 0 ? t('integrity_ok', name, String(p.files.length)) : t('integrity_warning', name, String(total)));
    return;
  }
  for (const p of localdb.getAllPackages()) {
    let missing = 0, empty = 0;
    for (const f of p.files) {
      if (!fs.existsSync(f)) { missing++; continue; }
      try { if (fs.statSync(f).size === 0) empty++; } catch {}
    }
    const total = missing + empty;
    if (total > 0) console.log(t('integrity_warning_global', p.name, String(total)));
  }
}

export function showInfo(name: string, fromRepo: boolean): void {
  if (fromRepo) {
    const p = findInRepo(name);
    if (!p) { console.error(t('error_not_found', name)); return; }
    console.log(t('info_repo', p.repo));
    console.log(t('info_name', p.package));
    console.log(t('info_version', p.version));
    console.log(t('info_description', p.description || ''));
    if (p.depends) console.log(t('info_depends', p.depends));
    if (p.size) console.log(t('info_download_size', (p.size / 1024).toFixed(2) + ' KiB'));
    return;
  }

  const dpkg = readDpkgStatus();
  const p = dpkg.get(name);
  if (!p) { console.error(t('error_was_not_found', name)); return; }

  const our = localdb.getPackage(name);
  const m = !!our;

  // Dynamic key alignment for any locale
  const lines: [string, string][] = [];
  lines.push(['Name', p.package]);
  lines.push(['Version', p.version]);
  lines.push(['Description', p.description || '']);
  lines.push(['Architecture', p.architecture]);
  lines.push(['URL', p.homepage || '']);
  if (m && our) lines.push(['Install Reason', our.reason === 'explicit' ? 'Explicitly installed' : 'Installed as a dependency']);
  if (!m) lines.push(['Install Reason', 'Installed via dpkg']);
  if (p.depends) lines.push(['Depends On', p.depends]);
  if (p.installedSize) lines.push(['Installed Size', (p.installedSize / 1024).toFixed(2) + ' KiB']);
  if (p.maintainer) lines.push(['Packager', p.maintainer]);
  if (our) {
    if (our.repo) lines.push(['Repository', our.repo]);
    lines.push(['Files', String(our.files.length)]);
    lines.push(['Install Date', new Date(our.installTime).toISOString().slice(0, 10)]);
  }

  // Compute max key width considering CJK (each CJK char ≈ 2 width)
  const cjk = (s: string) => { let w = 0; for (const c of s) w += c.charCodeAt(0) > 127 ? 2 : 1; return w; };
  const maxW = Math.max(...lines.map(([k]) => cjk(k)));
  for (const [k, v] of lines) {
    const pad = maxW - cjk(k);
    console.log(`${k}${' '.repeat(pad)} : ${v}`);
  }
}

export function queryFile(fp: string): void {
  const owner = localdb.getFileOwner(fp);
  if (owner) { console.log(t('file_owned_by', fp, owner)); return; }
  // Fallback: scan dpkg info files for file ownership
  const infoDir = '/var/lib/dpkg/info';
  if (fs.existsSync(infoDir)) {
    for (const entry of fs.readdirSync(infoDir)) {
      if (!entry.endsWith('.list')) continue;
      try {
        const content = fs.readFileSync(`${infoDir}/${entry}`, 'utf8');
        if (content.split('\n').some(l => l.trim() === fp)) {
          console.log(t('file_owned_by', fp, entry.slice(0, -5)));
          return;
        }
      } catch {}
    }
  }
  console.error(t('error_no_pkg_owns_file', fp));
}

export function listFiles(name: string): void {
  const p = localdb.getPackage(name);
  if (p) { for (const f of p.files) console.log(`${name} ${f}`); return; }
  const lp = `/var/lib/dpkg/info/${name}.list`;
  if (fs.existsSync(lp)) {
    for (const f of fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean)) console.log(`${name} ${f}`);
    return;
  }
  console.error(t('error_was_not_found', name));
}
