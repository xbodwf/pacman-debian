import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../repo/config';
import { loadDatabase } from '../db/database';
import { t } from '../i18n';
import { color } from '../ui/colors';
import { parseDep, verCmp } from './deps';
import type { Config } from './types';

export interface HookTxnPkg {
  name: string;
  /** Files present after the transaction (leading slash). */
  files: string[];
  /** Files present before an upgrade (leading slash). Undefined for fresh installs. */
  oldFiles?: string[];
}

export interface HookTxn {
  /** Packages installed or upgraded in this transaction. */
  adds: HookTxnPkg[];
  /** Packages removed in this transaction. */
  removes: HookTxnPkg[];
}

type HookOp = 'Install' | 'Upgrade' | 'Remove';
type HookWhen = 'PreTransaction' | 'PostTransaction';

interface HookTrigger {
  ops: Set<HookOp>;
  type: 'Package' | 'Path';
  targets: string[];
}

interface Hook {
  name: string;
  desc?: string;
  triggers: HookTrigger[];
  depends: string[];
  cmd: string[];
  when: HookWhen;
  abortOnFail: boolean;
  needsTargets: boolean;
  matches: string[];
}

/* ---- Shell glob matching (subset of POSIX fnmatch) ---- */

/** Match a single pattern against a string. Supports `*`, `?`, `[...]`, `[!...]`, `\` escapes. */
export function matchGlob(pattern: string, str: string): boolean {
  let p = 0, s = 0;
  let starP = -1, starS = 0;

  const matchBracket = (start: number): { matched: boolean; next: number } => {
    let j = start + 1;
    let negate = false;
    if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) {
      negate = true;
      j++;
    }
    let matched = false;
    if (j < pattern.length && pattern[j] === ']') {
      if (str[s] === ']') matched = true;
      j++;
    }
    while (j < pattern.length && pattern[j] !== ']') {
      if (pattern[j] === '\\' && j + 1 < pattern.length) {
        if (pattern[j + 1] === str[s]) matched = true;
        j += 2;
      } else if (j + 2 < pattern.length && pattern[j + 1] === '-' && pattern[j + 2] !== ']') {
        const lo = pattern.charCodeAt(j), hi = pattern.charCodeAt(j + 2);
        const c = str.charCodeAt(s);
        if (c >= lo && c <= hi) matched = true;
        j += 3;
      } else {
        if (pattern[j] === str[s]) matched = true;
        j++;
      }
    }
    if (j < pattern.length && pattern[j] === ']') j++;
    return { matched: negate ? !matched : matched, next: j };
  };

  while (s < str.length) {
    if (p < pattern.length) {
      const ch = pattern[p];
      if (ch === '\\' && p + 1 < pattern.length) {
        if (pattern[p + 1] === str[s]) { p += 2; s++; continue; }
        p += 2;
      } else if (ch === '?') { p++; s++; continue; }
      else if (ch === '[') {
        const b = matchBracket(p);
        if (b.matched) { p = b.next; s++; continue; }
      } else if (ch === '*') {
        starP = p; starS = s;
        while (p < pattern.length && pattern[p] === '*') p++;
        if (p === pattern.length) return true;
        continue;
      } else if (ch === str[s]) { p++; s++; continue; }
    }
    // mismatch: backtrack to last star if any
    if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Match a list of patterns against a string, mirroring `_alpm_fnmatch_patterns`:
 * patterns are checked last-to-first and the first match wins. A `!`-prefixed
 * pattern inverts the result, i.e. it excludes the string from the match.
 */
export function matchPatterns(patterns: string[], str: string): boolean {
  for (let i = patterns.length - 1; i >= 0; i--) {
    let pattern = patterns[i];
    let inverted = false;
    if (pattern[0] === '!') { inverted = true; pattern = pattern.slice(1); }
    else if (pattern[0] === '\\') pattern = pattern.slice(1);
    if (matchGlob(pattern, str)) return !inverted;
  }
  return false;
}

/* ---- POSIX-ish wordsplit for Exec ---- */

function wordsplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let escaping = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaping) { cur += ch; escaping = false; continue; }
    if (ch === '\\' && quote !== "'") { escaping = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (escaping) cur += '\\';
  if (cur) out.push(cur);
  return out;
}

/* ---- INI parsing ---- */

export function parseHookFile(filePath: string): Hook | null {
  const content = fs.readFileSync(filePath, 'utf8');
  const hook: Hook = {
    name: path.basename(filePath),
    triggers: [], depends: [], cmd: [], when: 'PostTransaction',
    abortOnFail: false, needsTargets: false, matches: [],
  };
  let section: string | null = null;
  let cur: HookTrigger | null = null;
  let valid = true;
  let whenSet = false;

  for (const raw of content.split('\n')) {
    let line = raw.replace(/[ \t\r]+$/, '');
    if (/^\s*#/.test(line)) continue;
    line = line.trim();
    if (!line) continue;
    const sm = line.match(/^\[(.+)\]$/);
    if (sm) {
      section = sm[1];
      if (section === 'Trigger') {
        cur = { ops: new Set(), type: 'Package', targets: [] };
        hook.triggers.push(cur);
      } else if (section === 'Action') {
        cur = null;
      } else {
        valid = false;
      }
      continue;
    }
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    const value = (eq === -1 ? '' : line.slice(eq + 1)).trim();

    if (section === 'Trigger' && cur) {
      if (key === 'Operation') {
        if (value === 'Install') cur.ops.add('Install');
        else if (value === 'Upgrade') cur.ops.add('Upgrade');
        else if (value === 'Remove') cur.ops.add('Remove');
        else valid = false;
      } else if (key === 'Type') {
        if (value === 'Package') cur.type = 'Package';
        else if (value === 'Path') cur.type = 'Path';
        else valid = false;
      } else if (key === 'Target') {
        cur.targets.push(value);
      } else {
        valid = false;
      }
    } else if (section === 'Action') {
      if (key === 'When') {
        if (value === 'PreTransaction') { hook.when = 'PreTransaction'; whenSet = true; }
        else if (value === 'PostTransaction') { hook.when = 'PostTransaction'; whenSet = true; }
        else valid = false;
      } else if (key === 'Description') {
        hook.desc = value;
      } else if (key === 'Depends') {
        hook.depends.push(value);
      } else if (key === 'AbortOnFail') {
        hook.abortOnFail = true;
      } else if (key === 'NeedsTargets') {
        hook.needsTargets = true;
      } else if (key === 'Exec') {
        hook.cmd = wordsplit(value);
      } else {
        valid = false;
      }
    } else {
      valid = false;
    }
  }

  if (!valid) return null;
  if (hook.triggers.length === 0 && hook.cmd.length === 0) return null;
  // triggerless hooks are valid (used to mask lower priority hooks), but a hook
  // without an Exec cannot run
  if (hook.cmd.length === 0) return null;
  if (!whenSet) return null;
  if (hook.triggers.length > 0) {
    for (const tr of hook.triggers) {
      if (tr.targets.length === 0 || tr.ops.size === 0) return null;
    }
  }
  return hook;
}

/* ---- Hook directory discovery ---- */

function hookDirs(cfg: Config): string[] {
  const system = path.join(cfg.rootDir, 'usr/share/libalpm/hooks');
  const user = cfg.hookDirs.map(d => (d.startsWith('/') ? d : path.join(cfg.rootDir, d)));
  return [system, ...user];
}

function loadHooks(cfg: Config): Hook[] {
  const found = new Map<string, Hook>();
  const dirs = hookDirs(cfg);
  // Later directories override earlier ones of the same name.
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = dirs[i];
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.name.endsWith('.hook')) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (found.has(entry.name)) continue;
      const hook = parseHookFile(path.join(dir, entry.name));
      if (hook) found.set(entry.name, hook);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- Trigger matching ---- */

/** Normalize stored file paths (leading slash) to hook target style (no leading slash). */
function normPath(f: string): string {
  return f.replace(/^\/+/, '');
}

function matchesNoExtract(cfg: Config, file: string): boolean {
  for (const p of cfg.noExtract) {
    const pattern = normPath(p);
    if (matchGlob(pattern, normPath(file))) return true;
  }
  return false;
}

function matchPathTrigger(cfg: Config, hook: Hook, t: HookTrigger, txn: HookTxn): boolean {
  const install: string[] = [];
  const upgrade: string[] = [];
  const remove: string[] = [];

  const isInstall = t.ops.has('Install');
  const isUpgrade = t.ops.has('Upgrade');
  const isRemove = t.ops.has('Remove');

  for (const pkg of txn.adds) {
    const oldSet = pkg.oldFiles ? new Set(pkg.oldFiles.map(normPath)) : new Set<string>();
    for (const f of pkg.files) {
      const nf = normPath(f);
      if (matchesNoExtract(cfg, nf)) continue;
      if (isInstall && !oldSet.has(nf)) install.push(nf);
      if (isUpgrade && oldSet.has(nf)) upgrade.push(nf);
    }
  }
  if (isRemove) {
    for (const pkg of txn.removes) {
      for (const f of pkg.files) {
        const nf = normPath(f);
        remove.push(nf);
      }
    }
  }

  const installHit = isInstall && install.some(f => matchPatterns(t.targets, f));
  const upgradeHit = isUpgrade && upgrade.some(f => matchPatterns(t.targets, f));
  const removeHit = isRemove && remove.some(f => matchPatterns(t.targets, f));

  if (hook.needsTargets) {
    if (isInstall && installHit) for (const f of install) if (matchPatterns(t.targets, f)) hook.matches.push(f);
    if (isUpgrade && upgradeHit) for (const f of upgrade) if (matchPatterns(t.targets, f)) hook.matches.push(f);
    if (isRemove && removeHit) for (const f of remove) if (matchPatterns(t.targets, f)) hook.matches.push(f);
    return installHit || upgradeHit || removeHit;
  }
  return installHit || upgradeHit || removeHit;
}

function matchPkgTrigger(hook: Hook, t: HookTrigger, txn: HookTxn): boolean {
  const isInstall = t.ops.has('Install');
  const isUpgrade = t.ops.has('Upgrade');
  const isRemove = t.ops.has('Remove');
  let hit = false;

  if (isInstall || isUpgrade) {
    for (const pkg of txn.adds) {
      if (!matchPatterns(t.targets, pkg.name)) continue;
      const upgrading = !!pkg.oldFiles;
      if (upgrading && isUpgrade) {
        if (hook.needsTargets) hook.matches.push(pkg.name);
        hit = true;
      } else if (!upgrading && isInstall) {
        if (hook.needsTargets) hook.matches.push(pkg.name);
        hit = true;
      }
    }
  }
  if (isRemove) {
    for (const pkg of txn.removes) {
      if (!matchPatterns(t.targets, pkg.name)) continue;
      if (hook.needsTargets) hook.matches.push(pkg.name);
      hit = true;
    }
  }
  return hit;
}

function hookTriggered(cfg: Config, hook: Hook, txn: HookTxn): boolean {
  for (const t of hook.triggers) {
    const hit = t.type === 'Package'
      ? matchPkgTrigger(hook, t, txn)
      : matchPathTrigger(cfg, hook, t, txn);
    if (hit && !hook.needsTargets) return true;
  }
  return hook.needsTargets && hook.matches.length > 0;
}

/* ---- Dependency satisfaction ---- */

function satisfiesVersion(installed: string, operator: string, required: string): boolean {
  const cmp = verCmp(installed, required);
  switch (operator) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=': case '==': return cmp === 0;
    default: return true;
  }
}

function findSatisfier(installed: Array<{ name: string; version: string; provides?: string }>, dep: string): boolean {
  const req = parseDep(dep)[0];
  if (!req || !req.name) return false;
  for (const pkg of installed) {
    if (pkg.name === req.name) {
      if (req.operator && req.version && !satisfiesVersion(pkg.version, req.operator, req.version)) continue;
      return true;
    }
    for (const prov of (pkg.provides || '').split(',')) {
      const pv = prov.trim();
      if (!pv) continue;
      const eq = pv.indexOf('=');
      const pname = eq >= 0 ? pv.slice(0, eq).trim() : pv;
      if (pname !== req.name) continue;
      const pver = eq >= 0 ? pv.slice(eq + 1).trim() : undefined;
      const effective = pver !== undefined ? pver : pkg.version;
      if (req.operator && req.version && !satisfiesVersion(effective, req.operator, req.version)) continue;
      return true;
    }
  }
  return false;
}

/* ---- Execution ---- */

function runHook(hook: Hook): boolean {
  const cmd = hook.cmd[0];
  const args = hook.cmd.slice(1);
  if (!cmd) return false;
  let input: string | undefined;
  if (hook.needsTargets) {
    const matches = [...new Set(hook.matches)].sort();
    input = matches.join('\n') + (matches.length ? '\n' : '');
  }
  try {
    const res = spawnSync(cmd, args, {
      input, encoding: 'utf8', cwd: '/',
      stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      // Mirror the PATH alpm runs hooks with, so binaries like ldconfig
      // (in /usr/sbin) are found regardless of the calling shell's PATH.
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    // A child that exits without reading stdin reports EPIPE via `error`
    // even on success; only treat real errors as failures.
    if (res.error && (res.error as NodeJS.ErrnoException).code !== 'EPIPE') return false;
    return res.status === 0;
  } catch {
    return false;
  }
}

/* ---- Public entry point ---- */

/**
 * Run post-transaction hooks. Prints the `:: Running post-transaction hooks...`
 * header only when at least one hook triggers, then `(n/n) desc` per hook.
 * Hook failures are logged but do not fail the transaction.
 */
export function runPostHooks(txn: HookTxn): void {
  runPostHooksWith(loadConfig(), txn);
}

export function runPostHooksWith(cfg: Config, txn: HookTxn): void {
  const hooks = loadHooks(cfg);
  const db = loadDatabase();

  const installed = [...db.packages.values()].map(p => ({
    name: p.name, version: p.version, provides: p.provides,
  }));

  const triggered: Hook[] = [];
  for (const hook of hooks) {
    if (hook.when !== 'PostTransaction') continue;
    hook.matches = [];
    if (hookTriggered(cfg, hook, txn)) {
      let depsOk = true;
      for (const d of hook.depends) {
        if (!findSatisfier(installed, d)) { depsOk = false; break; }
      }
      if (!depsOk) {
        console.error(`error: unable to run hook ${color.pkg(hook.name)}: could not satisfy dependencies`);
        continue;
      }
      triggered.push(hook);
    }
  }

  if (triggered.length === 0) return;
  console.log(t('running_hooks'));
  const digits = String(triggered.length).length;
  for (let i = 0; i < triggered.length; i++) {
    const hook = triggered[i];
    const label = hook.desc || hook.name;
    console.log(`(${String(i + 1).padStart(digits)}/${String(triggered.length).padStart(digits)}) ${label}`);
    if (!runHook(hook)) {
      console.error(`error: command failed to execute correctly (${color.pkg(hook.cmd[0])})`);
    }
  }
}
