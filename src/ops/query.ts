import * as fs from 'node:fs';
import * as localdb from '../db/localdb';
import { loadDatabase } from '../db/database';
import { readDpkgStatus } from '../db/dpkg-compat';
import { searchRepo, findInRepo, batchFindInRepo } from '../repo/repository';
import { terminalWidth } from '../ui/progress';
import { t } from '../i18n';
import { color } from '../ui/colors';
import { humanizeSize } from '../ui/format';

interface InstalledView {
  name: string;
  version: string;
  description: string;
  groups?: string[];
}

function allInstalled(): InstalledView[] {
  const dpkg = readDpkgStatus();
  // Build the local record map once; getPackage() per-call would rescan the
  // whole local dir for every package.
  const ours = new Map(localdb.getAllPackages().map(p => [p.name, p]));
  const result: InstalledView[] = [];
  for (const [name, p] of dpkg) {
    const our = ours.get(name);
    result.push({
      name: p.package || name,
      version: p.version,
      description: p.description || '',
      groups: our?.groups,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Word-wrap `str` like pacman's `indentprint`: break at spaces when the next
 * word would overflow `cols`, continuing lines on a fresh `indent` columns.
 * Mirrors official util.c:indentprint().
 */
function indentprint(str: string, indent: number, cols: number): string {
  if (!str) return '';
  if (cols === 0 || indent > cols) return str;
  let out = '';
  let cidx = indent;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ') {
      i++;
      if (i >= str.length || str[i] === ' ') continue;
      // width of the next word (up to the following space)
      let wordW = 0;
      let j = i;
      while (j < str.length && str[j] !== ' ') { wordW += terminalWidth(str[j]); j++; }
      if ((wordW + 1) > (cols - cidx)) {
        out += '\n' + ' '.repeat(indent);
        cidx = indent;
      } else {
        out += ' ';
        cidx++;
      }
      continue;
    }
    out += ch;
    cidx += terminalWidth(ch);
    i++;
  }
  return out;
}

export function listInstalled(quiet = false): void {
  const pkgs = allInstalled();
  if (pkgs.length === 0) { console.log(t('no_pkgs_installed')); return; }
  for (const p of pkgs) {
    if (quiet) { console.log(p.name); continue; }
    // official -Q: `name version` — name = title(bold), version = version(green)
    console.log(`${color.title(p.name)} ${color.version(p.version)}`);
  }
}

/** -Qs search: `local/name version (groups)` + indented description (official package.c dump_pkg_search). */
export function searchInstalled(filter: string, quiet = false): void {
  const lq = filter.toLowerCase();
  const cols = process.stdout.columns || 80;
  const pkgs = allInstalled().filter(p =>
    p.name.toLowerCase().includes(lq) || p.description.toLowerCase().includes(lq));
  if (pkgs.length === 0) { console.log(t('no_pkg_found_matching', filter)); return; }
  for (const p of pkgs) {
    if (quiet) { console.log(p.name); continue; }
    let line = `${color.repo('local')}/${color.title(p.name)} ${color.version(p.version)}`;
    if (p.groups && p.groups.length > 0) {
      line += ` ${color.groups('(' + p.groups.join(' ') + ')')}`;
    }
    console.log(line);
    if (p.description) {
      console.log('    ' + indentprint(p.description, 4, cols));
    }
  }
}

export function listForeign(quiet = false): void {
  const pkgs = allInstalled();
  const found = batchFindInRepo(pkgs.map(p => p.name));
  for (const p of pkgs) {
    if (found.has(p.name)) continue;
    if (quiet) { console.log(p.name); continue; }
    console.log(`${color.title(p.name)} ${color.version(p.version)}`);
  }
}

export function listExplicit(): void {
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'explicit');
  for (const p of pkgs) console.log(`${color.title(p.name)} ${color.version(p.version)}`);
}

export function listDeps(): void {
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'dependency');
  for (const p of pkgs) console.log(`${color.title(p.name)} ${color.version(p.version)}`);
}

export function listOrphans(): void {
  const needed = new Set<string>();
  for (const p of localdb.getAllPackages()) {
    const deps = (p.depends || '').split(',').map(s => s.trim().split(/\s/)[0]).filter(Boolean);
    for (const d of deps) needed.add(d);
  }
  const pkgs = localdb.getAllPackages().filter(p => p.reason === 'dependency' && !needed.has(p.name));
  for (const p of pkgs) console.log(`${color.title(p.name)} ${color.version(p.version)}`);
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
     if (!p) { console.error(color.error(t('error_not_found', name))); return; }
    const lines: Array<[string, string]> = [];
    lines.push([t('info_repo_label'), p.repo]);
    lines.push([t('info_name_label'), p.package]);
    lines.push([t('info_version_label'), p.version]);
    lines.push([t('info_description_label'), p.description || '']);
    if (p.depends) lines.push([t('info_depends_label'), p.depends]);
    if (p.size) {
      const [v, unit] = humanizeSize(p.size);
      lines.push([t('info_download_size_label'), `${v} ${unit}`]);
    }
    printInfoLines(lines);
    return;
  }

  const dpkg = readDpkgStatus();
  const p = dpkg.get(name);
   if (!p) { console.error(color.error(t('error_was_not_found', name))); return; }

  const our = localdb.getPackage(name);
  const m = !!our;

  const lines: Array<[string, string]> = [];
  lines.push([t('info_name_label'), p.package]);
  lines.push([t('info_version_label'), p.version]);
  lines.push([t('info_description_label'), p.description || '']);
  lines.push([t('info_architecture_label'), p.architecture]);
  if (p.homepage) lines.push([t('info_url_label'), p.homepage]);
  lines.push([t('info_install_reason_label'),
    !m ? t('info_install_reason_dpkg') : our.reason === 'explicit' ? t('info_install_reason_explicit') : t('info_install_reason_dep')]);
  if (p.depends) lines.push([t('info_depends_label'), p.depends]);
  if (p.installedSize) {
    const [v, unit] = humanizeSize(p.installedSize);
    lines.push([t('info_installed_size_label'), `${v} ${unit}`]);
  }
  if (p.maintainer) lines.push([t('info_packager_label'), p.maintainer]);
  if (our) {
    if (our.repo) lines.push([t('info_repo_label'), our.repo]);
    lines.push([t('info_files_label'), String(our.files.length)]);
    lines.push([t('info_install_date_label'), new Date(our.installTime).toISOString().slice(0, 10)]);
    if (our.groups && our.groups.length > 0) lines.push([t('info_groups_label'), our.groups.join(' ')]);
  }
  printInfoLines(lines);
}

/** Print localized label/value lines like pacman's aligned bold titles. */
function printInfoLines(lines: Array<[string, string]>): void {
  const cols = process.stdout.columns || 80;
  const cjk = (s: string) => { let w = 0; for (const c of s) w += terminalWidth(c); return w; };
  const maxW = Math.max(...lines.map(([k]) => cjk(k)));
  for (const [k, v] of lines) {
    const pad = maxW - cjk(k);
    const head = `${color.title(k)}${' '.repeat(pad)} :`;
    const indent = cjk(k) + pad + 2;
    // wrap long values (official string_display -> indentprint)
    console.log(head + ' ' + indentprint(v, indent, cols));
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
