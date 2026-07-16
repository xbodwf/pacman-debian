import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

let _lockProc: ChildProcess | null = null;
let _lockCount = 0;

function helperPath(): string {
  const local = path.join(__dirname, 'dpkg-helper');
  if (fs.existsSync(local)) return local;
  const dev = path.join(__dirname, '../../dist/lock/dpkg-helper');
  if (fs.existsSync(dev)) return dev;
  return '/usr/local/lib/pacman-debian/dpkg-helper';
}

export async function acquireDpkgLock(timeout = 0): Promise<void> {
  if (_lockCount > 0) { _lockCount++; return; }
  const hp = helperPath();
  return new Promise((resolve, reject) => {
    const cp = spawn(hp, [String(timeout)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolved = false;
    const errChunks: Buffer[] = [];
    cp.stderr.on('data', (c: Buffer) => errChunks.push(c));
    cp.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        const err = Buffer.concat(errChunks).toString('utf8');
        reject(new Error(err || `dpkg-lock exited with code ${code}`));
      }
    });
    cp.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });
    cp.stdout.on('data', (data: Buffer) => {
      if (!resolved && data.toString('utf8').includes('ok')) {
        resolved = true;
        _lockProc = cp;
        _lockCount = 1;
        resolve();
      }
    });
  });
}

export function releaseDpkgLock(): void {
  if (_lockCount > 1) { _lockCount--; return; }
  if (_lockProc) {
    _lockProc.kill();
    _lockProc = null;
  }
  _lockCount = 0;
}

export function isDpkgLocked(): boolean {
  return _lockCount > 0;
}

export async function withDpkgLock<T>(fn: () => T | Promise<T>, timeout = 30): Promise<T> {
  await acquireDpkgLock(timeout);
  try {
    return await fn();
  } finally {
    releaseDpkgLock();
  }
}
