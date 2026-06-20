import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as zlib from 'node:zlib';

import { loadConfig } from './config';
import { parseControlFile } from '../core/control';
import { decompress, decompressAsync } from '../core/compress';
import { iterateTar, readFileFromTar } from '../core/tar';
import { parseDescFile } from '../core/pkgfile';
import type { RepoPkg, RepoConfig } from '../core/types';
import { color } from '../ui/colors';
import { t } from '../i18n';
import { humanSize, formatRate, formatETA, drawProgressBar } from '../ui/progress';

const CACHE_DIR = '/var/cache/pacman-debian';
const PKG_CACHE = path.join(CACHE_DIR, 'packages');
const DEB_CACHE = path.join(CACHE_DIR, 'pkg');

/* ---- Shared keep-alive HTTP agents ---- */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

/* ---- Sorted index cache (in-memory, with provides inverted index) ---- */
interface IdxLineInfo {
  pkgName: string;
  provides: string;
  chunkFile: string;
  offset: number;
}

interface IdxEntry {
  lines: string[];
  mtime: number;
  providesIndex: Map<string, Array<{ chunkFile: string; offset: number }>>;
}

let _idxCache = new Map<string, IdxEntry>();

export function invalidateIdxCache(): void {
  _idxCache.clear();
}

function parseIdxLine(line: string): IdxLineInfo | null {
  const lastTab = line.lastIndexOf('\t');
  if (lastTab < 0) return null;
  const offset = parseInt(line.slice(lastTab + 1), 10);
  if (isNaN(offset)) return null;
  const beforeOff = line.slice(0, lastTab);
  const secondLastTab = beforeOff.lastIndexOf('\t');
  if (secondLastTab < 0) return null;
  const chunkFile = beforeOff.slice(secondLastTab + 1);
  if (!chunkFile) return null;
  const rest = beforeOff.slice(0, secondLastTab);
  const firstTab = rest.indexOf('\t');
  const pkgName = rest.slice(0, rest.indexOf(' '));
  const provides = firstTab >= 0 ? rest.slice(firstTab + 1) : '';
  return { pkgName, provides, chunkFile, offset };
}

function getIdx(repoName: string): IdxEntry | null {
  const pkgDir = path.join(PKG_CACHE, repoName);
  const idxPath = path.join(pkgDir, 'packages.idx');
  if (!fs.existsSync(idxPath)) return null;
  const st = fs.statSync(idxPath);
  const cached = _idxCache.get(repoName);
  if (cached && cached.mtime === st.mtimeMs) return cached;

  const lines = fs.readFileSync(idxPath, 'utf8').split('\n').filter(l => l.length > 0);
  const providesIndex = new Map<string, Array<{ chunkFile: string; offset: number }>>();

  for (const line of lines) {
    const info = parseIdxLine(line);
    if (!info || !info.provides) continue;
    for (const pr of info.provides.split(',')) {
      const pn = pr.trim().split(/[<>=]/)[0].trim();
      if (pn && pn !== info.pkgName) {
        if (!providesIndex.has(pn)) providesIndex.set(pn, []);
        providesIndex.get(pn)!.push({ chunkFile: info.chunkFile, offset: info.offset });
      }
    }
  }

  const entry: IdxEntry = { lines, mtime: st.mtimeMs, providesIndex };
  _idxCache.set(repoName, entry);
  return entry;
}

async function downloadFile(url: string, onProgress?: (received: number, total: number) => void, ifModifiedSince?: string): Promise<Buffer | null> {
  const maxRedirects = 5;
  const doRequest = (u: string, redirects: number): Promise<Buffer | null> => {
    return new Promise((resolve, reject) => {
      const mod = u.startsWith('https') ? https : http;
      const agent = u.startsWith('https') ? httpsAgent : httpAgent;
      const headers: Record<string, string> = { 'User-Agent': 'Wget/1.21' };
      if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;

      const req = mod.get(u, { headers, agent, timeout: 20000 }, (res) => {
        if (res.statusCode === 304) { res.destroy(); resolve(null); return; }
        // Handle redirects (301, 302, 303, 307, 308)
        if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400)) {
          const loc = res.headers['location'];
          res.destroy();
          if (!loc || redirects >= maxRedirects) { reject(new Error('redirect limit')); return; }
          const next = loc.startsWith('http') ? loc : new URL(loc, u).href;
          doRequest(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.destroy();
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
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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

async function syncDebian(repo: RepoConfig, arch: string, ifModifiedSince?: string, onProgress?: (rec: number, tot: number) => void): Promise<{ pkgs: RepoPkg[]; size: number; notModified: boolean }> {
  const comps = repo.components || ['main'];
  const all: RepoPkg[] = [];
  let totalSize = 0;
  for (const comp of comps) {
    const base = `${repo.server}/dists/${repo.dist}/${comp}/binary-${arch}/Packages`;
    for (const ext of ['gz', 'xz']) {
      let gotData = false;
      try {
        const url = `${base}.${ext}`;
        const buf = await downloadFile(url, (rec, tot) => {
          if (onProgress) onProgress(totalSize + rec, totalSize + (tot || 0));
        }, ifModifiedSince);
        if (buf === null) return { pkgs: [], size: 0, notModified: true }; // 304
        gotData = true;
        totalSize += buf.length;
        const text = (await decompressAsync(buf, `packages.${ext}`)).toString('utf8');
        all.push(...parseDebianPackages(text, repo.name));
        break;
      } catch (e: any) { if (gotData) throw e; }
    }
    ifModifiedSince = undefined;
  }
  return { pkgs: all, size: totalSize, notModified: false };
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
    this.rows = names.map(n => ` ${color.repo(n)}`);
    if (!process.stdout.isTTY) return;
    // Reserve lines for each repo (writes repo name immediately)
    for (let i = 0; i < names.length; i++) process.stdout.write(` ${color.repo(names[i])}\n`);
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
    // Flush ALL remaining dirty rows synchronously
    const cols = process.stdout.columns || 80;
    while (this.dirty.length) {
      const idx = this.dirty.shift()!;
      const n = this.count - idx;
      if (n > 0) process.stdout.write(`\x1b[${n}A`);
      process.stdout.write(`\r\x1b[2K${this.rows[idx]}`);
      if (n > 0) process.stdout.write(`\x1b[${n}B`);
    }
    process.stdout.write('\n');
  }

  private flush() {
    if (this.dirty.length === 0) return;
    const idx = this.dirty.shift()!;
    const n = this.count - idx;
    const cols = process.stdout.columns || 80;
    if (n > 0) process.stdout.write(`\x1b[${n}A`);
    process.stdout.write(`\r\x1b[2K${this.rows[idx]}`);
    if (n > 0) process.stdout.write(`\x1b[${n}B`);
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
  const namePad = Math.max(...cfg.repos.map(r => r.name.length)) + 2;
  progress.init(cfg.repos.map(r => r.name));

  const tasks = cfg.repos.map(async (repo, idx) => {
    const pname = color.repo(repo.name);
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
      return ` ${pname}${' '.repeat(namePad - repo.name.length)}${color.size(dl.val.padStart(7))} ${dl.unit.padEnd(3)}  ${color.rate(rateStr)} ${etaStr} [${bar}] ${String(pct).padStart(3)}%`;
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
      let notModified = false;
      if (repo.type === 'arch') {
        pkgs = await syncArch(repo, cfg.architecture, ifModifiedSince, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress();
        });
        notModified = ifModifiedSince !== undefined && pkgs.length === 0 && totalDownloaded === 0;
      } else {
        const result = await syncDebian(repo, cfg.architecture, ifModifiedSince, (rec, tot) => {
          totalDownloaded = rec; totalExpected = tot;
          updateProgress();
        });
        pkgs = result.pkgs;
        notModified = result.notModified;
      }

      if (notModified) {
        progress.setRow(idx, ` ${pname}${' '.repeat(namePad - repo.name.length)}${color.ok(t('repo_already_uptodate'))}`);
        return;
      }

      // Write JSON Lines chunks (parallel per chunk)
      const pkgDir = path.join(PKG_CACHE, repo.name);
      if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
      const CHUNK = 5000;
      const chunks = Math.ceil(pkgs.length / CHUNK);
      const writeTasks = [];
      const idxLines: string[] = [];
      for (let c = 0; c < chunks; c++) {
        const chunk = pkgs.slice(c * CHUNK, (c + 1) * CHUNK);
        const lines = chunk.map(p => JSON.stringify(p)).join('\n');
        const fname = `${String(c).padStart(5, '0')}.jsonl`;
        writeTasks.push(fs.promises.writeFile(path.join(pkgDir, fname), lines + '\n'));
        // Build index with byte offsets (computed from previous chunk lengths)
        let offset = 0;
        for (let pi = 0; pi < chunk.length; pi++) {
          const p = chunk[pi];
          const json = JSON.stringify(p);
          const desc = (p.description || '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
          const provides = (p.provides || '').replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
          idxLines.push(`${p.package} ${desc}\t${provides}\t${fname}\t${offset}`);
          offset += Buffer.byteLength(json, 'utf8') + 1;
        }
      }
      await Promise.all(writeTasks);
      await fs.promises.writeFile(path.join(pkgDir, '.info'), JSON.stringify({ total: pkgs.length, chunks, chunkSize: CHUNK }));
      // Remove legacy all.json
      try { fs.unlinkSync(path.join(pkgDir, 'all.json')); } catch {}
      idxLines.sort(); // global sort so binary search works
      await fs.promises.writeFile(path.join(pkgDir, 'packages.idx'), idxLines.join('\n') + '\n');


      // Final line
      const elapsed = (Date.now() - startTime) / 1000;
      const totalSec = Math.round(elapsed);
      const finalRate = elapsed > 0 ? totalDownloaded / elapsed : 0;
      const dl = humanSize(totalDownloaded, 1);
      const rateStr = formatRate(finalRate);
      const bar = drawProgressBar(100, cols);
      progress.setRow(idx,
        ` ${pname}${' '.repeat(namePad - repo.name.length)}${color.size(dl.val.padStart(7))} ${dl.unit.padEnd(3)}  ${color.rate(rateStr)} ${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')} [${bar}] ${color.ok('100%')}`
      );
    } catch (e: any) {
      progress.setRow(idx, ` ${pname}${' '.repeat(namePad - repo.name.length)}${color.error(t('repo_sync_failed'))}: ${e.message}`);
    }
  });

  await Promise.all(tasks);
  progress.finish();
  invalidateCache();
}

/** Read a pkg from JSONL by byte offset (shared helper) */
export function readPkgAt(pkgDir: string, chunkFile: string, byteOff: number): RepoPkg | undefined {
  const fd = fs.openSync(path.join(pkgDir, chunkFile), 'r');
  const buf = Buffer.alloc(65536);
  const bytes = fs.readSync(fd, buf, 0, 65536, byteOff);
  fs.closeSync(fd);
  const end = buf.indexOf(10);
  const json = end >= 0 ? buf.toString('utf8', 0, end) : buf.toString('utf8', 0, bytes);
  try { return JSON.parse(json) as RepoPkg; } catch { return undefined; }
}

/** Batch read multiple entries from the same chunk file (open/close once) */
function batchReadPkgAt(pkgDir: string, chunkFile: string, requests: Array<{ pkgName: string; offset: number }>): RepoPkg[] {
  if (requests.length === 0) return [];
  const fp = path.join(pkgDir, chunkFile);
  const content = fs.readFileSync(fp, 'utf8');
  const lines = content.split('\n');
  const result: RepoPkg[] = [];
  let bytePos = 0;
  let ri = 0;
  for (let li = 0; li < lines.length && ri < requests.length; li++) {
    while (ri < requests.length && requests[ri].offset < bytePos) ri++;
    if (ri >= requests.length) break;
    if (requests[ri].offset === bytePos) {
      try { result.push(JSON.parse(lines[li]) as RepoPkg); } catch {}
      ri++;
    }
    bytePos += Buffer.byteLength(lines[li], 'utf8') + 1;
  }
  return result;
}

/**
 * Batch-resolve package names via head-tail dual scan on the sorted index.
 * Returns Map<packageName, RepoPkg> for all names found.
 */
export function batchFindInRepo(names: string[]): Map<string, RepoPkg> {
  const result = new Map<string, RepoPkg>();
  const sorted = [...new Set(names)].filter(n => n).sort();
  if (sorted.length === 0) return result;

  const cfg = loadConfig();
  for (const repo of cfg.repos) {
    const idxEntry = getIdx(repo.name);
    if (!idxEntry) continue;
    const { lines } = idxEntry;
    const pkgDir = path.join(PKG_CACHE, repo.name);

    const chunkRequests = new Map<string, Array<{ pkgName: string; offset: number }>>();
    let h = 0, t = lines.length - 1;
    let hT = 0, tT = sorted.length - 1;

    while (hT <= tT && h <= t) {
      // Head side
      if (h <= t) {
        const hLine = lines[h];
        const hName = hLine.slice(0, hLine.indexOf(' '));
        const hTarget = sorted[hT];
        if (hName === hTarget) {
          const info = parseIdxLine(hLine);
          if (info) {
            if (!chunkRequests.has(info.chunkFile))
              chunkRequests.set(info.chunkFile, []);
            chunkRequests.get(info.chunkFile)!.push({ pkgName: info.pkgName, offset: info.offset });
          }
          hT++; h++;
        } else if (hName < hTarget) {
          h++;
        } else {
          hT++;
        }
      }

      // Tail side
      if (h < t && hT <= tT) {
        const tLine = lines[t];
        const tName = tLine.slice(0, tLine.indexOf(' '));
        const tTarget = sorted[tT];
        if (tName === tTarget) {
          const info = parseIdxLine(tLine);
          if (info) {
            if (!chunkRequests.has(info.chunkFile))
              chunkRequests.set(info.chunkFile, []);
            chunkRequests.get(info.chunkFile)!.push({ pkgName: info.pkgName, offset: info.offset });
          }
          tT--; t--;
        } else if (tName > tTarget) {
          t--;
        } else {
          tT--;
        }
      }
    }

    // Batch-read JSONL
    for (const [chunkFile, requests] of chunkRequests) {
      const pkgs = batchReadPkgAt(pkgDir, chunkFile, requests);
      for (const p of pkgs) {
        if (!result.has(p.package)) result.set(p.package, p);
      }
    }
  }
  return result;
}

/** Look up a package by its Provides: virtual name via inverted index */
export function findProvides(name: string): RepoPkg | undefined {
  const cfg = loadConfig();
  for (const repo of cfg.repos) {
    const idxEntry = getIdx(repo.name);
    if (!idxEntry) continue;
    const entries = idxEntry.providesIndex.get(name);
    if (entries) {
      const pkgDir = path.join(PKG_CACHE, repo.name);
      for (const e of entries) {
        const p = readPkgAt(pkgDir, e.chunkFile, e.offset);
        if (p) return p;
      }
    }
  }
  return undefined;
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
    const idxEntry = getIdx(repo.name);
    if (!idxEntry) continue;
    const { lines } = idxEntry;
    const pkgDir = path.join(PKG_CACHE, repo.name);

    const chunkRequests = new Map<string, Array<{ pkgName: string; offset: number }>>();
    for (const line of lines) {
      const info = parseIdxLine(line);
      if (info && !seen.has(info.pkgName)) {
        seen.add(info.pkgName);
        if (!chunkRequests.has(info.chunkFile))
          chunkRequests.set(info.chunkFile, []);
        chunkRequests.get(info.chunkFile)!.push({ pkgName: info.pkgName, offset: info.offset });
      }
    }
    for (const [chunkFile, requests] of chunkRequests) {
      all.push(...batchReadPkgAt(pkgDir, chunkFile, requests));
    }
  }

  _cache = all;
  return all;
}

export function invalidateCache(): void {
  _cache = null;
  invalidateIdxCache();
}

export function searchRepo(query: string): RepoPkg[] {
  const lq = query.toLowerCase();
  const results: RepoPkg[] = [];
  const cfg = loadConfig();
  const seen = new Set<string>();

  for (const repo of cfg.repos) {
    const idxEntry = getIdx(repo.name);
    if (!idxEntry) continue;
    const { lines } = idxEntry;
    const pkgDir = path.join(PKG_CACHE, repo.name);

    for (const line of lines) {
      if (!line.toLowerCase().includes(lq)) continue;
      const info = parseIdxLine(line);
      if (!info || seen.has(info.pkgName)) continue;
      seen.add(info.pkgName);
      const p = readPkgAt(pkgDir, info.chunkFile, info.offset);
      if (p) results.push(p);
    }
  }

  return results;
}

export function findInRepo(pkgName: string): RepoPkg | undefined {
  const cfg = loadConfig();
  for (const repo of cfg.repos) {
    const idxEntry = getIdx(repo.name);
    if (!idxEntry) continue;
    const { lines } = idxEntry;
    const pkgDir = path.join(PKG_CACHE, repo.name);

    let lo = 0, hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const line = lines[mid];
      const pname = line.slice(0, line.indexOf(' '));
      if (pkgName < pname) hi = mid - 1;
      else if (pkgName > pname) lo = mid + 1;
      else {
        const info = parseIdxLine(line);
        if (info) return readPkgAt(pkgDir, info.chunkFile, info.offset);
        return undefined;
      }
    }
  }
  return undefined;
}

/** Resolve the download URL for a package. */
export function getPkgUrl(rp: RepoPkg): string {
  const cfg = loadConfig();
  if (rp.repoType === 'arch') {
    const repo = cfg.repos.find(r => r.name === rp.repo);
    if (!repo) throw new Error(`repo ${rp.repo} not found`);
    const arch = repo.architecture || cfg.architecture;
    return `${resolveServer(repo.server, repo.name, arch)}/${rp.filename}`;
  }
  const repo = cfg.repos.find(r => r.name === rp.repo);
  if (!repo) throw new Error(`repo ${rp.repo} not found`);
  return `${repo.server}/${rp.filename}`;
}

export async function downloadPkg(rp: RepoPkg, dest?: string, onProgress?: (rec: number, tot: number) => void): Promise<string> {
  if (!fs.existsSync(DEB_CACHE)) fs.mkdirSync(DEB_CACHE, { recursive: true });
  const fn = path.basename(rp.filename);
  const local = path.join(dest || DEB_CACHE, fn);
  if (fs.existsSync(local)) return local;

  const url = getPkgUrl(rp);
  const data = await downloadFile(url, onProgress);
  if (!data) throw new Error('failed to download package');
  fs.writeFileSync(local, data);
  return local;
}