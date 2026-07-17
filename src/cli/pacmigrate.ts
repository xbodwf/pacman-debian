#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { scopedT } from '../i18n';

const t = scopedT('pacmigrate');
const CONFIG_DIR = '/etc/pacman-debian';
const CONFIG_PATH = path.join(CONFIG_DIR, 'pacman.conf');

interface AptSource { uri: string; suite: string; components: string[]; }

function ask(question: string, defaultAnswer: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`${question} `, answer => { rl.close(); resolve(answer.trim() || defaultAnswer); }));
}

async function askYes(key: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await ask(t(key), defaultYes ? 'y' : 'n')).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function sourceFiles(): string[] {
  const files = fs.existsSync('/etc/apt/sources.list') ? ['/etc/apt/sources.list'] : [];
  const dir = '/etc/apt/sources.list.d';
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.list') || name.endsWith('.sources')) files.push(path.join(dir, name));
    }
  }
  return files;
}

function parseList(content: string, file: string): AptSource[] {
  const result: AptSource[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.startsWith('deb ')) continue;
    const fields = line.split(/\s+/).slice(1);
    if (fields[0]?.startsWith('[')) {
      while (fields.length && !/^https?:\/\//.test(fields[0])) fields.shift();
    }
    if (fields.length < 3) { console.warn(t('source_skipped', `${file}: ${line}`)); continue; }
    const [uri, suite, ...components] = fields;
    if (uri && suite && components.length) result.push({ uri, suite, components });
  }
  return result;
}

function parseSources(content: string, file: string): AptSource[] {
  const result: AptSource[] = [];
  for (const paragraph of content.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const raw of paragraph.split('\n')) {
      const match = raw.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
      if (match) fields.set(match[1].toLowerCase(), match[2].trim());
    }
    if (fields.get('enabled')?.toLowerCase() === 'no') continue;
    if (!(fields.get('types') || '').split(/\s+/).includes('deb')) continue;
    const uris = (fields.get('uris') || '').split(/\s+/).filter(Boolean);
    const suites = (fields.get('suites') || '').split(/\s+/).filter(Boolean);
    const components = (fields.get('components') || '').split(/\s+/).filter(Boolean);
    if (!uris.length || !suites.length || !components.length) { console.warn(t('source_skipped', file)); continue; }
    for (const uri of uris) for (const suite of suites) result.push({ uri, suite, components });
  }
  return result;
}

function readSources(): AptSource[] {
  const result: AptSource[] = [];
  for (const file of sourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    result.push(...(file.endsWith('.sources') ? parseSources(content, file) : parseList(content, file)));
  }
  const seen = new Set<string>();
  return result.filter(source => {
    const key = `${source.uri}|${source.suite}|${source.components.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repoName(source: AptSource, index: number): string {
  const host = new URL(source.uri).hostname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${source.suite}-${host || index}`.toLowerCase();
}

function makeConfig(sources: AptSource[], parallel: number, verbose: boolean, color: boolean, checkSpace: boolean): string {
  const lines = ['[options]', 'Architecture = auto', 'HoldPkg = pacman glibc', `ParallelDownloads = ${parallel}`, `CheckSpace = ${checkSpace ? 'true' : 'false'}`, ...(color ? ['Color'] : []), ...(verbose ? ['VerbosePkgLists'] : []), 'SigLevel = Never', 'LocalFileSigLevel = Optional', ''];
  sources.forEach((source, index) => lines.push(`[${repoName(source, index)}]`, `Server = ${source.uri}`, 'Type = debian', `Dist = ${source.suite}`, `Components = ${source.components.join(' ')}`, ''));
  return lines.join('\n');
}

async function setup(): Promise<void> {
  if (process.getuid && process.getuid() !== 0) { console.error(t('need_root')); process.exitCode = 1; return; }
  const sources = readSources();
  if (!sources.length) { console.error(t('no_sources')); process.exitCode = 1; return; }
  console.log(t('source_count', sources.length));
  for (const source of sources) console.log(`  ${source.uri} ${source.suite} ${source.components.join(' ')}`);
  if (!await askYes('prompt_confirm', true)) { console.log(t('cancelled')); return; }
  const requested = parseInt(await ask(t('prompt_parallel', 5), '5'), 10);
  const parallel = Number.isFinite(requested) && requested > 0 ? requested : 5;
  const verbose = await askYes('prompt_verbose', false);
  const color = await askYes('prompt_color', true);
  const checkSpace = await askYes('prompt_check_space', true);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak.${Date.now()}`;
    fs.copyFileSync(CONFIG_PATH, backup);
    console.log(t('backup_created', backup));
  }
  fs.writeFileSync(CONFIG_PATH, makeConfig(sources, parallel, verbose, color, checkSpace) + '\n');
  console.log(t('config_written', CONFIG_PATH));
  console.log(t('complete'));
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'setup' || process.argv.length > 3) { console.error(t('usage')); process.exitCode = 2; return; }
  await setup();
}

main().catch(error => { console.error(t('error_prefix', error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
