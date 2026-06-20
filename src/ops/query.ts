import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as localdb from '../db/localdb';
import { loadDatabase } from '../db/database';
import { readDpkgStatus } from '../db/dpkg-compat';
import { searchRepo } from '../repo/repository';
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
  for (const p of pkgs) console.log(quiet ? p.package : `${p.package} ${p.version}`);
}

export function listExplicit(): void {
  for (const p of localdb.getAllPackages()) {
    if (p.reason === 'explicit') console.log(`${p.name} ${p.version}`);
  }
}

export function listDeps(): void {
  for (const p of localdb.getAllPackages()) {
    if (p.reason === 'dependency') console.log(`${p.name} ${p.version}`);
  }
}

export function listOrphans(): void {
  const needed = new Set<string>();
  for (const p of localdb.getAllPackages()) {
    const deps = (p.depends || '').split(',').map(s => s.trim().split(/\s/)[0]).filter(Boolean);
    for (const d of deps) needed.add(d);
  }
  for (const p of localdb.getAllPackages()) {
    if (p.reason === 'dependency' && !needed.has(p.name)) console.log(`${p.name} ${p.version}`);
  }
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
    const r = searchRepo(name);
    const p = r.find(x => x.package === name);
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

  console.log(t('info_name', p.package));
  console.log(t('info_version', p.version));
  console.log(t('info_description', p.description || ''));
  console.log(t('info_architecture', p.architecture));
  console.log(t('info_url', p.homepage || ''));
  if (m && our) console.log(t(our.reason === 'explicit' ? 'info_install_reason_explicit' : 'info_install_reason_dep'));
  if (!m) console.log(t('info_install_reason_dpkg'));
  if (p.depends) console.log(t('info_depends', p.depends));
  if (p.installedSize) console.log(t('info_installed_size', (p.installedSize / 1024).toFixed(2) + ' KiB'));
  if (p.maintainer) console.log(t('info_packager', p.maintainer));
  if (our) {
    console.log(t('info_files', String(our.files.length)));
    console.log(t('info_install_date', new Date(our.installTime).toISOString().slice(0, 10)));
  }
}

export function queryFile(fp: string): void {
  const owner = localdb.getFileOwner(fp);
  if (owner) { console.log(t('file_owned_by', fp, owner)); return; }
  try {
    const out = execSync(`dpkg -S ${fp} 2>/dev/null`, { encoding: 'utf8' });
    console.log(out.trim());
  } catch {
    console.error(t('error_no_pkg_owns_file', fp));
  }
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
