import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as zlib from 'node:zlib';

import { loadConfig } from './config';
import { parseControlFile } from '../core/control';
import { decompress } from '../core/compress';
import { iterateTar, readFileFromTar } from '../core/tar';
import { parseDescFile } from '../core/pkgfile';
import type { RepoPkg, RepoConfig } from '../core/types';
import { color } from '../ui/colors';
import { t } from '../i18n';
import { humanSize, formatRate, formatETA, drawProgressBar } from '../ui/progress';

const CACHE_DIR = '/var/cache/pacman-debian';
const PKG_CACHE = path.join(CACHE_DIR, 'packages');
const DEB_CACHE = path.join(CACHE_DIR, 'pkg');

async function downloadFile(url: string, onProgress?: (received: number, total: number) => void, ifModifiedSince?: string): Promise<Buffer | null> {
  const maxRedirects = 5;
  const doRequest = (u: string, redirects: number): Promise<Buffer | null> => {
    return new Promise((resolve, reject) => {
      const mod = u.startsWith('https') ? https : http;
      const headers: Record<string, string> = { 'User-Agent': 'Wget/1.21' };
      if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;

      mod.get(u, { headers }, (res) => {
        if (res.statusCode === 304) { resolve(null); return; }
        if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400)) {
          const loc = res.headers['location'];
          if (!loc || redirects >= maxRedirects) { reject(new Error('redirect limit')); return; }
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

async function syncDebian(repo: RepoConfig, arch: string, ifModifiedSince?: string, onProgress?: (rec: number, tot: number) => void): Promise<{ pkgs: RepoPkg[]; size: number }> {
  const all: RepoPkg[] = [];
  let totalSize = 0;
  const comps = repo.components || ['main'];
  for (const comp of comps) {
    const base = `${repo.server}/dists/${repo.dist}/${comp}/binary-${arch}/Packages`;
    for (const ext of ['gz', 'xz']) {
      let gotData = false;
      try {
        const url = `${base}.${ext}`;
        const buf = await downloadFile(url, (rec, tot) => {
          if (onProgress) onProgress(totalSize + rec, totalSize + (tot || 0));
        }, ifModifiedSince);
        if (buf === null) return { pkgs: [], size: 0 }; // 304
        gotData = true;
        totalSize += buf.length;
        const text = decompress(buf, `packages.${ext}`).toString('utf8');
        all.push(...parseDebianPackages(text, repo.name));
        break;
      } catch (e: any) { if (gotData) throw e; }
    }
    ifModifiedSince = undefined;
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
    const dependsParsed = parseDescFile(dependsContent);
    const depends = (dependsParsed['depends'] || []).map(l => l.trim().split(/[<>=]/)[0].trim()).filter(Boolean);
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

function resolveServer(server: string, repoName: string, arch: string): string {
  return server.replace(/\$repo/g, repoName).replace(/\$arch/g, arch);
}

async function syncArch(repo: RepoConfig, globalArch: string, ifModifiedSince?: string, onProgress?: (rec: number, tot: number) => void): Promise<RepoPkg[]> {
  const arch = repo.architecture || globalArch;
  const baseUrl = resolveServer(repo.server, repo.name, arch);
  const dbFile = repo.dbFile || `${repo.name}.db.tar.gz`;
  const url = `${baseUrl}/${dbFile}`;
  const buf = await downloadFile(url, onProgress, ifModifiedSince);
  if (buf === null) return []; // 304 — up to date
  const tar = decompress(buf, 'repo.tar.gz');
  return parseArchDb(tar, repo.name);
}

// ---- Multi-line progress: each repo gets its own row ----
// Uses ANSI cursor-up (ESC[A) to reach a specific row, writes in-place,
// then cursor-down (ESC[B) back to bottom. No absolute positioning.
class RepoProgress {
  private rows: string[] = [];
  private dirty: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private count = 0;

  init(names: string[]) {
    this.count = names.length;
    // Initialize rows with just the repo name (shown before download starts)
    this.rows = names.map(n => ` ${color.repo(`${n}.db`)}`);
    if (!process.stdout.isTTY) return;
    // Reserve lines for each repo (writes repo name immediately)
    for (let i = 0; i < names.length; i++) process.stdout.write(` ${color.repo(`${names[i]}.db`)}\n`);
    // Mark all as dirty so first flush updates them
    this.dirty = names.map((_, i) => i);
    this.timer = setInterval(() => this.flush(), 200);
  }

  setRow(idx: number, text: string) {
    if (idx < 0 || idx >= this.count) return;
    if (this.rows[idx] === text) return;
    this.rows[idx] = text;
    if (this.dirty.indexOf(idx) < 0) this.dirty.push(idx);
  }

  finish() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!process.stdout.isTTY) {
      for (const r of this.rows) process.stdout.write(r + '\n');
      return;
    }
    this.flush();
    process.stdout.write('\n');
  }

  private flush() {
    if (this.dirty.length === 0) return;
    const idx = this.dirty.shift()!;
    // Move up from bottom to the target row
    const up = this.count - 1 - idx;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    process.stdout.write(`\r${this.rows[idx]}\x1b[K`);
    if (up > 0) process.stdout.write(`\x1b[${up}B`);
    setImmediate(() => this.flush());
  }
}

// ---- Write mutex ----
const writeQueue: string[] = [];
let writing = false;

function safeWrite(s: string) {
  writeQueue.push(s);
  if (!writing) flushWrite();
}

function flushWrite() {
  if (writeQueue.length === 0) { writing = false; return; }
  writing = true;
  const s = writeQueue.shift()!;
  if (process.stdout.write(s)) {
    setImmediate(flushWrite);
  } else {
    process.stdout.once('drain', flushWrite);
  }
}

// ---- Main sync ----
export async function syncRepos(force: boolean = false): Promise<void> {
  const cfg = loadConfig();
  if (!fs.existsSync(PKG_CACHE)) fs.mkdirSync(PKG_CACHE, { recursive: true });
  const cols = process.stdout.columns || 80;
  const progress = new RepoProgress();
  progress.init(cfg.repos.map(r => r.name));

  const tasks = cfg.repos.map(async (repo, idx) => {
    const fname = `${repo.name}.db`;
    let ifModifiedSince: string | undefined;

    if (!force) {
      const infoFile = path.join(PKG_CACHE, repo.name, '.info');
      if (fs.existsSync(infoFile)) {
        try {
          const st = fs.statSync(infoFile);
          ifModifiedSince = st.mtime.toUTCString();
        } catch {}
      }
    }

    let totalDownloaded = 0;
    let totalExpected = 0;
    const startTime = Date.now();
    let prevTime = startTime;
    let prevBytes = 0;
    let smoothedRate = 0;

    const fmtProgress = () => {
      const dl = humanSize(totalDownloaded, 1);
      const rateStr = formatRate(smoothedRate);
      const eta = smoothedRate > 0 && totalExpected > 0 ? (totalExpected - totalDownloaded) / smoothedRate : 0;
      const etaStr = formatETA(eta);
      const pct = totalExpected > 0 ? Math.round(totalDownloaded / totalExpected * 100) : 0;
      const bar = drawProgressBar(pct, cols);
      const pad = Math.max(20 - fname.length, 1);
      return ` ${color.repo(fname)}${' '.repeat(pad)}${color.size(dl.val.padStart(6))} ${dl.unit}  ${color.rate(rateStr)} ${etaStr} [${bar}] ${String(pct).padStart(3)}%`;
    };

    const updateProgress = () => {
      const now = Date.now();
      if (now - prevTime < 200) return;
      const chunkTime = Math.max((now - prevTime) / 1000, 0.001);
      smoothedRate = smoothedRate > 0
        ? ((totalDownloaded - prevBytes) / chunkTime + 2 * smoothedRate) / 3
        : (totalDownloaded - prevBytes) / chunkTime;
      prevTime = now;
      prevBytes = totalDownloaded;
      progress.setRow(idx, fmtProgress());
    };

    try {
      let pkgs: RepoPkg[];
      if (repo.type === 'arch') {
        pkgs = await syncArch(repo, cfg.architecture, ifModifiedSince, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress();
        });
      } else {
        const result = await syncDebian(repo, cfg.architecture, ifModifiedSince, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress();
        });
        pkgs = result.pkgs;
      }

      if (ifModifiedSince && pkgs.length === 0 && totalDownloaded === 0) {
        progress.setRow(idx, ` ${color.repo(fname)} ${color.ok(t('repo_already_uptodate', fname))}`);
        return;
      }

      // Write JSON Lines chunks
      const pkgDir = path.join(PKG_CACHE, repo.name);
      if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
      const CHUNK = 5000;
      const chunks = Math.ceil(pkgs.length / CHUNK);
      for (let c = 0; c < chunks; c++) {
        const chunk = pkgs.slice(c * CHUNK, (c + 1) * CHUNK);
        const lines = chunk.map(p => JSON.stringify(p)).join('\n');
        fs.writeFileSync(path.join(pkgDir, `${String(c).padStart(5, '0')}.jsonl`), lines + '\n');
      }
      fs.writeFileSync(path.join(pkgDir, '.info'), JSON.stringify({ total: pkgs.length, chunks, chunkSize: CHUNK }));

      // Final line
      const elapsed = (Date.now() - startTime) / 1000;
      const totalSec = Math.round(elapsed);
      const finalRate = elapsed > 0 ? totalDownloaded / elapsed : 0;
      const dl = humanSize(totalDownloaded, 1);
      const rateStr = formatRate(finalRate);
      const bar = drawProgressBar(100, cols);
      const pad = Math.max(20 - fname.length, 1);
      progress.setRow(idx,
        ` ${color.repo(fname)}${' '.repeat(pad)}${color.size(dl.val.padStart(6))} ${dl.unit}  ${color.rate(rateStr)} ${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')} [${bar}] ${color.ok('100%')}`
      );
    } catch (e: any) {
      progress.setRow(idx, ` ${color.repo(fname)} ${color.error(t('repo_sync_failed'))}: ${e.message}`);
    }
  });

  await Promise.all(tasks);
  progress.finish();
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
    const pkgDir = path.join(PKG_CACHE, repo.name);
    if (!fs.existsSync(pkgDir)) continue;
    const files = fs.readdirSync(pkgDir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(pkgDir, f), 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const p = JSON.parse(line) as RepoPkg;
          if (!seen.has(p.package)) {
            seen.add(p.package);
            all.push(p);
          }
        } catch {}
      }
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
  // Fast path: scan JSONL chunks with native Node (no external command)
  const pattern = `"package":"${pkgName}"`;
  const cfg = loadConfig();
  for (const repo of cfg.repos) {
    const pkgDir = path.join(PKG_CACHE, repo.name);
    if (!fs.existsSync(pkgDir)) continue;
    const files = fs.readdirSync(pkgDir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(pkgDir, f), 'utf8').split('\n');
      for (const line of lines) {
        if (line.includes(pattern)) {
          try { return JSON.parse(line) as RepoPkg; } catch { return undefined; }
        }
      }
    }
  }
  return undefined;
}

export async function downloadPkg(rp: RepoPkg, dest?: string, onProgress?: (rec: number, tot: number) => void): Promise<string> {
  if (!fs.existsSync(DEB_CACHE)) fs.mkdirSync(DEB_CACHE, { recursive: true });
  const fn = path.basename(rp.filename);
  const local = path.join(dest || DEB_CACHE, fn);
  if (fs.existsSync(local)) return local;

  let url: string;
  if (rp.repoType === 'arch') {
    const cfg = loadConfig();
    const repo = cfg.repos.find(r => r.name === rp.repo);
    if (!repo) throw new Error(`repo ${rp.repo} not found`);
    const arch = repo.architecture || cfg.architecture;
    url = `${resolveServer(repo.server, repo.name, arch)}/${rp.filename}`;
  } else {
    const cfg = loadConfig();
    const repo = cfg.repos.find(r => r.name === rp.repo);
    if (!repo) throw new Error(`repo ${rp.repo} not found`);
    url = `${repo.server}/${rp.filename}`;
  }

  const data = await downloadFile(url, onProgress);
  if (!data) throw new Error('failed to download package');
  fs.writeFileSync(local, data);
  return local;
}