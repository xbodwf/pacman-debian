import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../repo/config';

let logStream: fs.WriteStream | null = null;
let logPath = '';

function getStream(): fs.WriteStream | null {
  const cfg = loadConfig();
  if (!cfg.logFile) return null;
  if (cfg.logFile === logPath && logStream) return logStream;
  if (logStream) { try { logStream.end(); } catch {} }
  logPath = cfg.logFile;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch { return null; }
  return logStream;
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(msg: string): void {
  const s = getStream();
  if (!s) return;
  s.write(`[${ts()}] ${msg}\n`);
}

export function logInstall(pkg: string, ver: string, status: 'start' | 'done' | 'fail', detail?: string): void {
  log(`install: ${pkg}-${ver} ${status}${detail ? ' ' + detail : ''}`);
}

export function logRemove(pkg: string, ver: string, status: 'start' | 'done' | 'fail', detail?: string): void {
  log(`remove: ${pkg}-${ver} ${status}${detail ? ' ' + detail : ''}`);
}

export function logUpgrade(pkg: string, oldVer: string, newVer: string, status: 'start' | 'done' | 'fail'): void {
  log(`upgrade: ${pkg} ${oldVer} -> ${newVer} ${status}`);
}

export function logSync(repo: string, status: 'start' | 'done' | 'fail', detail?: string): void {
  log(`sync: ${repo} ${status}${detail ? ' ' + detail : ''}`);
}

export function logError(msg: string): void {
  log(`error: ${msg}`);
}
