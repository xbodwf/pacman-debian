import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, RepoConfig } from '../core/types';

const CONFIG_PATHS = ['/etc/pacman-debian/pacman.conf', '/etc/pacman/pacman.conf', '/etc/pacman.conf'];
const INCLUDE_DIR = '/etc/pacman-debian';

function findConfig(): string {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return CONFIG_PATHS[0];
}

function parseKeyValue(line: string): [string, string] | null {
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  return [line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim()];
}

function applyKeyValue(cur: RepoConfig, key: string, value: string, isOverride: boolean): void {
  if (key === 'server' && (isOverride || !cur.server)) cur.server = value;
  else if (key === 'type' && (isOverride || !cur.type)) cur.type = value === 'arch' ? 'arch' : 'debian';
  else if (key === 'dist' && (isOverride || !cur.dist)) cur.dist = value;
  else if (key === 'components' && (isOverride || !cur.components?.length)) cur.components = value.split(/\s+/).filter(Boolean);
  else if (key === 'dbfile' && (isOverride || !cur.dbFile)) cur.dbFile = value;
  else if (key === 'architecture' && (isOverride || !cur.architecture)) cur.architecture = value;
}

function loadRepoFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const kv = parseKeyValue(t);
    if (kv) result[kv[0]] = kv[1];
  }
  return result;
}

function strList(v: string): string[] {
  return v.split(/\s+/).filter(Boolean);
}

export function loadConfig(): Config {
  const nativeArch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const cfg: Config = {
    architecture: nativeArch, color: false, parallelDownloads: 1,
    checkSpace: false, ignorePkg: [], ignoreGroup: [], noUpgrade: [], noExtract: [],
    verbosePkgLists: false, cleanMethod: 'KeepInstalled',
    dbPath: '/var/lib/pacman-debian', cacheDir: '/var/cache/pacman-debian',
    logFile: '', rootDir: '/', repos: [],
  };
  const configPath = findConfig();
  if (!fs.existsSync(configPath)) {
    cfg.repos.push({ name: 'ubuntu', type: 'debian', server: 'http://ports.ubuntu.com/ubuntu-ports', dist: 'noble', components: ['main', 'universe'] });
    return cfg;
  }

  const content = fs.readFileSync(configPath, 'utf8');
  let cur: RepoConfig | null = null;
  let inOptions = false;

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sm = t.match(/^\[(.+)\]$/);
    if (sm) {
      if (cur) { if (!cur.type) cur.type = 'debian'; cfg.repos.push(cur); }
      const n = sm[1];
      if (n === 'options') { cur = null; inOptions = true; continue; }
      cur = { name: n, server: '', dist: '', components: [] };
      inOptions = false;
      continue;
    }
    const kv = parseKeyValue(t);
    if (!kv) {
      const flag = t.trim().toLowerCase();
      if (flag === 'color' && (inOptions || !cur)) cfg.color = true;
      continue;
    }
    const [k, v] = kv;

    if (inOptions || !cur) {
      if (k === 'architecture') cfg.architecture = v;
      else if (k === 'paralleldownloads') { const n = parseInt(v, 10); if (!isNaN(n) && n > 0) cfg.parallelDownloads = n; }
      else if (k === 'xfercommand') cfg.xferCommand = v;
      else if (k === 'checkspace') cfg.checkSpace = v === 'true' || v === '1' || v === 'yes';
      else if (k === 'ignorepkg') cfg.ignorePkg = strList(v);
      else if (k === 'ignoregroup') cfg.ignoreGroup = strList(v);
      else if (k === 'noupgrade') cfg.noUpgrade = strList(v);
      else if (k === 'noextract') cfg.noExtract = strList(v);
      else if (k === 'verbosepkglists') cfg.verbosePkgLists = v === 'true' || v === '1' || v === 'yes';
      else if (k === 'cleanmethod') cfg.cleanMethod = v === 'KeepCurrent' ? 'KeepCurrent' : 'KeepInstalled';
      else if (k === 'dbpath') cfg.dbPath = v;
      else if (k === 'cachedir') cfg.cacheDir = v;
      else if (k === 'logfile') cfg.logFile = v;
      else if (k === 'rootdir') cfg.rootDir = v;
      continue;
    }

    if (k === 'include') {
      const incPath = v.startsWith('/') ? v : path.join(INCLUDE_DIR, v);
      const included = loadRepoFile(incPath);
      for (const [ik, iv] of Object.entries(included)) {
        applyKeyValue(cur, ik, iv, false);
      }
      continue;
    }

    applyKeyValue(cur, k, v, true);
  }

  if (cur) { if (!cur.type) cur.type = 'debian'; cfg.repos.push(cur); }
  return cfg;
}
