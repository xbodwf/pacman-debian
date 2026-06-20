import * as fs from 'node:fs';
import * as path from 'node:path';
import * as localdb from './localdb';
import type { InstalledPackage, Database, Transaction } from '../core/types';

const DATA_DIR = '/var/lib/pacman-debian';
const TRANSACTIONS_DIR = path.join(DATA_DIR, 'transactions');
const INFO_DIR = path.join(DATA_DIR, 'info');

function ensureDir(dir: string) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

export function initDb(): void {
  ensureDir(TRANSACTIONS_DIR); ensureDir(INFO_DIR);
}

export function loadDatabase(): Database {
  const db: Database = { packages: new Map(), fileIndex: new Map() };
  for (const pkg of localdb.getAllPackages()) {
    db.packages.set(pkg.name, pkg);
    for (const f of pkg.files) {
      db.fileIndex.set(f, pkg.name);
    }
  }
  return db;
}

export function saveDatabase(_db: Database): void {
  // localdb persists writes immediately
}

export function isInstalled(db: Database, name: string): boolean {
  return db.packages.has(name) || !!localdb.getPackage(name);
}

export function getPackage(db: Database, name: string): InstalledPackage | undefined {
  return db.packages.get(name) || localdb.getPackage(name);
}

export function addPackage(db: Database, pkg: InstalledPackage): void {
  db.packages.set(pkg.name, pkg);
  localdb.addPackage(pkg);
}

export function removePkg(db: Database, name: string): InstalledPackage | undefined {
  const pkg = db.packages.get(name) || localdb.getPackage(name);
  if (!pkg) return undefined;
  for (const f of pkg.files) db.fileIndex.delete(f);
  db.packages.delete(name);
  localdb.removePackage(name, pkg.version);
  const base = path.join(INFO_DIR, name);
  for (const s of ['preinst', 'postinst', 'prerm', 'postrm']) {
    const fp = path.join(base, s);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  try { fs.rmdirSync(base); } catch {}
  return pkg;
}

export function saveScript(pkgName: string, name: string, content: string): void {
  const dir = path.join(INFO_DIR, pkgName);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
}

export function runScript(pkgName: string, name: string, args: string[]): boolean {
  const fp = path.join(INFO_DIR, pkgName, name);
  if (!fs.existsSync(fp)) return true;
  try {
    const { execSync } = require('node:child_process');
    execSync(`/bin/sh "${fp}" ${args.join(' ')}`, {
      stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    return true;
  } catch {
    return false;
  }
}

export function createTransaction(a: 'install' | 'remove', p: string, v: string): Transaction {
  ensureDir(TRANSACTIONS_DIR);
  const tx: Transaction = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(), action: a, package: p, version: v, completed: false,
  };
  fs.writeFileSync(path.join(TRANSACTIONS_DIR, `${tx.id}.json`), JSON.stringify(tx));
  return tx;
}

export function completeTransaction(id: string): void {
  const fp = path.join(TRANSACTIONS_DIR, `${id}.json`);
  if (fs.existsSync(fp)) {
    const tx = JSON.parse(fs.readFileSync(fp, 'utf8'));
    tx.completed = true;
    fs.writeFileSync(fp, JSON.stringify(tx));
  }
}

export interface DepEntry { name: string }
export function parseDepends(s?: string): DepEntry[] {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean).map(d => ({
    name: (d.match(/^\s*([\w.+-]+)/) || [])[1] || d.split(/\s/)[0],
  }));
}
