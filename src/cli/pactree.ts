#!/usr/bin/env node
import { getAllPackages, getPackage } from '../db/localdb';
import { readDpkgStatus } from '../db/dpkg-compat';
import { findInRepo, findProvides } from '../repo/repository';
import { parseDep } from '../core/deps';
import * as fs from 'node:fs';

const CACHE_DIR = '/var/cache/pacman-debian/packages';

interface PkgInfo {
  name: string;
  version: string;
  depends: string[];
  source: 'local' | 'dpkg' | 'repo' | 'not-found';
}

function resolveDep(name: string, dpkg: Map<string, any>, localPkgs: Map<string, PkgInfo>): PkgInfo | null {
  const clean = name.split(/[<>=]/)[0].split(':')[0].trim();

  if (localPkgs.has(clean)) return localPkgs.get(clean)!;
  if (dpkg.has(clean)) {
    const info = dpkg.get(clean);
    const deps = parseDepList(info.depends || info['Pre-Depends'] || '');
    const pkg: PkgInfo = { name: clean, version: info.version || '0', depends: deps, source: 'dpkg' };
    localPkgs.set(clean, pkg);
    return pkg;
  }

  const repo = findInRepo(clean) || findProvides(clean);
  if (repo) {
    const deps = parseDepList(repo.depends || '');
    const pkg: PkgInfo = { name: clean, version: repo.version || '0', depends: deps, source: 'repo' };
    localPkgs.set(clean, pkg);
    return pkg;
  }

  const pkg: PkgInfo = { name: clean, version: '?', depends: [], source: 'not-found' };
  localPkgs.set(clean, pkg);
  return pkg;
}

function parseDepList(s?: string): string[] {
  if (!s) return [];
  const deps = parseDep(s);
  return [...new Set(deps.map(d => d.name))];
}

function buildTree(
  name: string, dpkg: Map<string, any>, localPkgs: Map<string, PkgInfo>,
  depth: number, maxDepth: number, visited: Set<string>, _reverseDeps?: Map<string, string[]>
): string[] {
  if (depth > maxDepth) return [];
  if (visited.has(name)) return [`${'  '.repeat(depth)}└── ${name} (circular)`];
  visited.add(name);

  const pkg = resolveDep(name, dpkg, localPkgs);
  if (!pkg) return [`${'  '.repeat(depth)}└── ${name} (not found)`];

  const prefix = '  '.repeat(depth);
  const marker = depth === 0 ? '' : (depth > 0 ? '└── ' : '');
  const version = pkg.version !== '?' ? ` ${pkg.version}` : '';
  const srcTag = pkg.source === 'not-found' ? ' (not found)' : '';
  const lines: string[] = [`${prefix}${marker}${pkg.name}${version}${srcTag}`];

  for (const dep of pkg.depends) {
    const sub = buildTree(dep, dpkg, localPkgs, depth + 1, maxDepth, new Set(visited), _reverseDeps);
    lines.push(...sub);
  }

  return lines;
}

function findReverseDeps(dpkg: Map<string, any>, localPkgs: Map<string, PkgInfo>): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  const addRev = (parent: string, dep: string) => {
    if (!rev.has(dep)) rev.set(dep, []);
    rev.get(dep)!.push(parent);
  };
  for (const [name, info] of localPkgs) {
    for (const dep of info.depends) {
      const clean = dep.split(/[<>=]/)[0].split(':')[0].trim();
      addRev(name, clean);
    }
  }
  for (const [name, info] of dpkg) {
    const deps = parseDepList(info.depends || info['Pre-Depends'] || '');
    for (const dep of deps) {
      const clean = dep.split(/[<>=]/)[0].split(':')[0].trim();
      addRev(name, clean);
    }
    // Store for localPkgs
    const pkg: PkgInfo = { name, version: info.version || '0', depends: deps, source: 'dpkg' };
    if (!localPkgs.has(name)) localPkgs.set(name, pkg);
  }
  return rev;
}

function buildReverseTree(
  name: string, rev: Map<string, string[]>,
  depth: number, maxDepth: number, visited: Set<string>
): string[] {
  if (depth > maxDepth) return [];
  if (visited.has(name)) return [`${'  '.repeat(depth)}└── ${name} (circular)`];
  visited.add(name);

  const parents = rev.get(name);
  const prefix = '  '.repeat(depth);
  const lines: string[] = [`${prefix}${depth === 0 ? '' : '└── '}${name}`];

  if (parents) {
    for (const parent of parents) {
      const sub = buildReverseTree(parent, rev, depth + 1, maxDepth, new Set(visited));
      lines.push(...sub);
    }
  }

  return lines;
}

function help(): void {
  console.log(`pactree (pacman-debian) - package dependency tree viewer

usage:  pactree [options] <package>

options:
  -r, --reverse     Show reverse dependencies
  -d, --depth <n>   Maximum depth (default: unlimited)
  -s, --sync        Show sync info (version numbers)
  -h, --help        Show this help
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) { help(); return; }

  const reverse = args.includes('-r') || args.includes('--reverse');
  const sync = args.includes('-s') || args.includes('--sync');
  let maxDepth = 999;
  const depthIdx = args.indexOf('-d');
  if (depthIdx === -1) {
    const d2 = args.indexOf('--depth');
    if (d2 !== -1 && args[d2 + 1]) maxDepth = parseInt(args[d2 + 1], 10) || 999;
  } else if (args[depthIdx + 1]) {
    maxDepth = parseInt(args[depthIdx + 1], 10) || 999;
  }

  const cleanArgs = args.filter(a => !a.startsWith('-'));
  const pkgName = cleanArgs[0];
  if (!pkgName) { console.error('error: no package specified'); process.exit(1); }

  const dpkg = readDpkgStatus();
  const localPkgs = new Map<string, PkgInfo>();
  for (const p of getAllPackages()) {
    const deps = parseDepList(p.depends);
    localPkgs.set(p.name, { name: p.name, version: p.version || '0', depends: deps, source: 'local' });
  }

  if (!reverse) {
    const lines = buildTree(pkgName, dpkg, localPkgs, 0, maxDepth, new Set());
    console.log(lines.join('\n'));
  } else {
    // Build reverse dep map from all sources
    const rev = findReverseDeps(dpkg, localPkgs);
    // Also scan repo packages for reverse deps
    if (fs.existsSync(CACHE_DIR)) {
      for (const repoDir of fs.readdirSync(CACHE_DIR)) {
        const rp = path.join(CACHE_DIR, repoDir);
        if (!fs.statSync(rp).isDirectory()) continue;
        for (const chunk of fs.readdirSync(rp)) {
          if (!chunk.endsWith('.jsonl')) continue;
          const text = fs.readFileSync(path.join(rp, chunk), 'utf8');
          for (const line of text.split('\n').filter(Boolean)) {
            try {
              const p = JSON.parse(line);
              const deps = parseDepList(p.depends || '');
              for (const dep of deps) {
                const clean = dep.split(/[<>=]/)[0].split(':')[0].trim();
                if (!rev.has(clean)) rev.set(clean, []);
                if (!rev.get(clean)!.includes(p.package)) rev.get(clean)!.push(p.package);
              }
            } catch {}
          }
        }
      }
    }
    const lines = buildReverseTree(pkgName, rev, 0, maxDepth, new Set());
    console.log(lines.join('\n'));
  }
}

import * as path from 'node:path';
main().catch(e => { console.error(`error: ${e.message}`); process.exit(1); });
