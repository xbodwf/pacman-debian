import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { loadConfig } from './config';
import { parseControlFile } from '../core/control';
import { decompress } from '../core/compress';
import { iterateTar, readFileFromTar } from '../core/tar';
import { parseDescFile } from '../core/pkgfile';
import type { RepoPkg, RepoConfig } from '../core/types';

const CACHE_DIR = '/var/cache/pacman-debian';
const PKG_CACHE = path.join(CACHE_DIR, 'packages');
const DEB_CACHE = path.join(CACHE_DIR, 'pkg');

async function downloadFile(url: string, onProgress?: (received: number, total: number) => void): Promise<Buffer> {
  const maxRedirects = 5;
  const doRequest = (u: string, redirects: number): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { timeout: 60000, headers: { 'User-Agent': 'Wget/1.21' } }, (res) => {
        if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400)) {
          const loc = res.headers['location'];
          if (!loc || redirects >= maxRedirects) {
            reject(new Error(`redirect limit`));
            return;
          }
          const next = loc.startsWith('http') ? loc : new URL(loc, u).href;
          doRequest(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          received += c.length;
          if (onProgress) onProgress(received, total);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject).on('timeout', function (this: any) { this.destroy(); reject(new Error('timeout')); });
    });
  };
  return doRequest(url, 0);
}

function parseDebianPackages(content: string, repo: string): RepoPkg[] {
  const pkgs: RepoPkg[] = [];
  for (const entry of content.split('\n\n').filter(Boolean)) {
    const f = parseControlFile(entry);
    if (!f['package']) continue;
    pkgs.push({
      package: f['package'], version: f['version'] || '0.0',
      architecture: f['architecture'] || 'amd64',
      description: f['description']?.split('\n')[0],
      depends: f['depends'], conflicts: f['conflicts'], provides: f['provides'],
      filename: f['filename'] || '',
      size: f['size'] ? parseInt(f['size'], 10) : undefined,
      installedSize: f['installed-size'] ? parseInt(f['installed-size'], 10) : undefined,
      sha256: f['sha256'], repo, repoType: 'debian',
    });
  }
  return pkgs;
}

async function syncDebian(repo: RepoConfig, arch: string, onProgress?: (rec: number, tot: number) => void): Promise<{ pkgs: RepoPkg[]; size: number }> {
  const all: RepoPkg[] = [];
  let totalSize = 0;
  const comps = repo.components || ['main'];
  for (const comp of comps) {
    const base = `${repo.server}/dists/${repo.dist}/${comp}/binary-${arch}/Packages`;
    let buf: Buffer | null = null;
    for (const ext of ['gz', 'xz']) {
      try {
        const raw = await downloadFile(`${base}.${ext}`, (rec, tot) => {
          if (onProgress) onProgress(totalSize + rec, totalSize + (tot || 0));
        });
        totalSize += raw.length;
        buf = decompress(raw, `packages.${ext}`);
        break;
      } catch { continue; }
    }
    if (buf) all.push(...parseDebianPackages(buf.toString('utf8'), repo.name));
  }
  return { pkgs: all, size: totalSize };
}

function parseArchDb(dbTar: Buffer, repo: string): RepoPkg[] {
  const pkgs: RepoPkg[] = [];
  const entries = new Map<string, Buffer[]>();
  for (const entry of iterateTar(dbTar)) {
    const parts = entry.name.split('/');
    if (parts.length < 2) continue;
    const pkgDir = parts[0];
    const fileName = parts.slice(1).join('/');
    if (!entries.has(pkgDir)) entries.set(pkgDir, []);
    const data = entry.data || Buffer.alloc(0);
    const nameBuf = Buffer.from(fileName + '\0');
    const combined = Buffer.concat([nameBuf, data]);
    entries.get(pkgDir)!.push(combined);
  }
  for (const [dir, files] of entries) {
    let descContent = '', dependsContent = '';
    for (const combined of files) {
      const nullIdx = combined.indexOf(0);
      if (nullIdx === -1) continue;
      const name = combined.subarray(0, nullIdx).toString('utf8');
      const content = combined.subarray(nullIdx + 1).toString('utf8');
      if (name === 'desc') descContent = content;
      else if (name === 'depends') dependsContent = content;
    }
    if (!descContent) continue;
    const desc = parseDescFile(descContent);
    const depends = dependsContent.split('\n').map(l => l.trim().split(/[<>=]/)[0].trim()).filter(Boolean);
    const filename = (desc['filename'] || [''])[0];
    const pkgName = (desc['name'] || [''])[0];
    const version = (desc['version'] || [''])[0];
    if (!pkgName || !version) continue;
    const arch = (desc['arch'] || [''])[0];
    const csize = (desc['csize'] || [''])[0];
    const isize = (desc['isize'] || [''])[0];
    const descText = (desc['desc'] || [''])[0];
    pkgs.push({
      package: pkgName, version, architecture: arch || 'any', description: descText,
      depends: depends.join(', '), conflicts: (desc['conflicts'] || []).join(', '),
      provides: (desc['provides'] || []).join(', '), filename,
      size: csize ? parseInt(csize, 10) : undefined,
      installedSize: isize ? Math.ceil(parseInt(isize, 10) / 1024) : undefined,
      repo, repoType: 'arch',
    });
  }
  return pkgs;
}

async function syncArch(repo: RepoConfig, onProgress?: (rec: number, tot: number) => void): Promise<RepoPkg[]> {
  const url = `${repo.server}/${repo.name}.db.tar.gz`;
  const buf = await downloadFile(url, onProgress);
  const tar = decompress(buf, 'repo.tar.gz');
  return parseArchDb(tar, repo.name);
}

function humanSize(n: number, dec: number): { val: string; unit: string } {
  const abs = Math.abs(n);
  let v: number, u: string;
  if (abs < 1024) { v = n; u = 'B'; }
  else if (abs < 1048576) { v = n / 1024; u = 'KiB'; }
  else if (abs < 1073741824) { v = n / 1048576; u = 'MiB'; }
  else { v = n / 1073741824; u = 'GiB'; }
  return { val: v.toFixed(dec), unit: u };
}

// ---- Main sync ----
export async function syncRepos(): Promise<void> {
  const cfg = loadConfig();
  if (!fs.existsSync(PKG_CACHE)) fs.mkdirSync(PKG_CACHE, { recursive: true });
  const cols = process.stdout.columns || 80;

  for (const repo of cfg.repos) {
    let totalDownloaded = 0;
    let totalExpected = 0;
    const startTime = Date.now();
    let prevTime = startTime;
    let prevBytes = 0;
    let smoothedRate = 0;

    const fname = `${repo.name}.db`;
    const nameLen = Math.min(fname.length, 30);

    const updateProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - prevTime < 200) return;

      const chunkTime = Math.max((now - prevTime) / 1000, 0.001);
      const instantRate = (totalDownloaded - prevBytes) / chunkTime;
      smoothedRate = smoothedRate > 0 ? (instantRate + 2 * smoothedRate) / 3 : instantRate;

      prevTime = now;
      prevBytes = totalDownloaded;

      const dl = humanSize(totalDownloaded, 1);
      const rateStr = (() => {
        if (smoothedRate < 9.995) { const s = humanSize(smoothedRate, 2); return `${s.val.padStart(4)} ${s.unit}/s`; }
        if (smoothedRate < 99.95) { const s = humanSize(smoothedRate, 1); return `${s.val.padStart(4)} ${s.unit}/s`; }
        const s = humanSize(smoothedRate, 0); return `${s.val.padStart(4)} ${s.unit}/s`;
      })();

      const remaining = totalExpected > 0 ? totalExpected - totalDownloaded : 0;
      const eta = smoothedRate > 0 && totalExpected > 0 ? remaining / smoothedRate : 0;
      const etaStr = eta > 0 && eta < 7200
        ? `${String(Math.floor(eta / 60)).padStart(2, '0')}:${String(Math.floor(eta % 60)).padStart(2, '0')}`
        : '--:--';

      const pct = totalExpected > 0 ? Math.round(totalDownloaded / totalExpected * 100) : 0;
      const barLen = Math.max(Math.floor((cols - 55) * 0.35), 8);
      const hashes = Math.round(pct / 100 * barLen);
      const bar = '#'.repeat(hashes) + '-'.repeat(Math.max(barLen - hashes, 0));

      const pad = Math.max(20 - fname.length, 1);
      process.stdout.write(
        `\r ${fname}${' '.repeat(pad)}${dl.val.padStart(6)} ${dl.unit}  ${rateStr} ${etaStr} [${bar}] ${String(pct).padStart(3)}%`
      );
    };

    process.stdout.write(` ${fname}${' '.repeat(Math.max(25 - fname.length, 1))}`);

    let pkgs: RepoPkg[] = [];

    try {
      if (repo.type === 'arch') {
        pkgs = await syncArch(repo, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress(false);
        });
      } else {
        const result = await syncDebian(repo, cfg.architecture, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress(false);
        });
        pkgs = result.pkgs;
      }

      fs.writeFileSync(path.join(PKG_CACHE, `${repo.name}.json`), JSON.stringify(pkgs));
      updateProgress(true);

      // Final line (like pacman: stays on screen)
      const elapsed = (Date.now() - startTime) / 1000;
      const totalSec = Math.round(elapsed);
      const finalRate = elapsed > 0 ? totalDownloaded / elapsed : 0;
      const dl = humanSize(totalDownloaded, 1);
      const rateStr = (() => {
        if (finalRate < 9.995) { const s = humanSize(finalRate, 2); return `${s.val.padStart(4)} ${s.unit}/s`; }
        if (finalRate < 99.95) { const s = humanSize(finalRate, 1); return `${s.val.padStart(4)} ${s.unit}/s`; }
        const s = humanSize(finalRate, 0); return `${s.val.padStart(4)} ${s.unit}/s`;
      })();
      const etaM = Math.floor(totalSec / 60); const etaS = totalSec % 60;
      const barLen = Math.max(Math.floor((cols - 55) * 0.35), 8);
      const bar = '#'.repeat(barLen);
      const pad = Math.max(20 - fname.length, 1);

      process.stdout.write(
        `\r ${fname}${' '.repeat(pad)}${dl.val.padStart(6)} ${dl.unit}  ${rateStr} ${String(etaM).padStart(2, '0')}:${String(etaS).padStart(2, '0')} [${bar}] 100%\n`
      );

      if (pkgs.length === 0) {
        console.error(`  WARNING: ${repo.name} returned 0 packages (wrong architecture? check pacman.conf)`);
      }
    } catch (e: any) {
      process.stdout.write(`\r ${fname}${' '.repeat(Math.max(20 - fname.length, 1))}failed to download\n`);
      console.error(`  WARNING: failed to sync ${repo.name}: ${e.message}`);
    }
  }

  invalidateCache();
}

// ---- Cache ----
let _cache: RepoPkg[] | null = null;

export function getRepoCache(): RepoPkg[] {
  if (_cache) return _cache;
  if (!fs.existsSync(PKG_CACHE)) { _cache = []; return _cache; }

  const cfg = loadConfig();
  const seen = new Set<string>();
  const all: RepoPkg[] = [];

  for (const repo of cfg.repos) {
    const fp = path.join(PKG_CACHE, `${repo.name}.json`);
    if (!fs.existsSync(fp)) continue;
    const pkgs: RepoPkg[] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const p of pkgs) {
      if (seen.has(p.package)) continue;
      seen.add(p.package);
      all.push(p);
    }
  }

  for (const f of fs.readdirSync(PKG_CACHE)) {
    if (!f.endsWith('.json')) continue;
    const name = f.replace(/\.json$/, '');
    if (cfg.repos.some(r => r.name === name)) continue;
    const pkgs: RepoPkg[] = JSON.parse(fs.readFileSync(path.join(PKG_CACHE, f), 'utf8'));
    for (const p of pkgs) {
      if (seen.has(p.package)) continue;
      seen.add(p.package);
      all.push(p);
    }
  }

  _cache = all;
  return all;
}

export function invalidateCache(): void { _cache = null; }

export function searchRepo(query: string): RepoPkg[] {
  const lq = query.toLowerCase();
  return getRepoCache().filter(p =>
    p.package.toLowerCase().includes(lq) ||
    (p.description && p.description.toLowerCase().includes(lq))
  );
}

export function findInRepo(pkgName: string): RepoPkg | undefined {
  return getRepoCache().find(p => p.package === pkgName);
}

export async function downloadPkg(rp: RepoPkg, dest?: string): Promise<string> {
  if (!fs.existsSync(DEB_CACHE)) fs.mkdirSync(DEB_CACHE, { recursive: true });
  const fn = path.basename(rp.filename);
  const local = path.join(dest || DEB_CACHE, fn);
  if (fs.existsSync(local)) return local;

  let url: string;
  if (rp.repoType === 'arch') {
    const cfg = loadConfig();
    const repo = cfg.repos.find(r => r.name === rp.repo);
    if (!repo) throw new Error(`repo ${rp.repo} not found`);
    url = `${repo.server}/${rp.filename}`;
  } else {
    const cfg = loadConfig();
    const repo = cfg.repos.find(r => r.name === rp.repo);
    if (!repo) throw new Error(`repo ${rp.repo} not found`);
    url = `${repo.server}/${rp.filename}`;
  }

  const data = await downloadFile(url);
  fs.writeFileSync(local, data);
  return local;
}