#!/usr/bin/env node
import { loadConfig } from '../repo/config';

function main(): void {
  const cfg = loadConfig();
  const args = process.argv.slice(2);

  // Filter out flags we don't handle (go-pacmanconf calls us with these)
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '--root' || args[i] === '-r') { i++; continue; }
    filtered.push(args[i]);
  }

  const [section, directive] = filtered;

  if (!section) {
    // Print entire config (simplified)
    console.log('# pacman-debian configuration');
    console.log(`[options]`);
    console.log(`Architecture = ${cfg.architecture}`);
    console.log('');
    for (const repo of cfg.repos) {
      console.log(`[${repo.name}]`);
      console.log(`Server = ${repo.server}`);
      if (repo.type) console.log(`Type = ${repo.type}`);
      if (repo.dist) console.log(`Dist = ${repo.dist}`);
      if (repo.components?.length) console.log(`Components = ${repo.components.join(' ')}`);
      if (repo.dbFile) console.log(`DbFile = ${repo.dbFile}`);
      if (repo.architecture) console.log(`Architecture = ${repo.architecture}`);
      console.log('');
    }
    return;
  }

  if (section === 'options') {
    if (directive === 'architecture' || directive === 'Architecture') {
      console.log(cfg.architecture);
    }
    return;
  }

  // Look up a repo section
  const repo = cfg.repos.find(r => r.name === section);
  if (!repo) {
    if (!directive) {
      // Section not found, maybe it's a directive lookup in options
      if (section === 'architecture' || section === 'Architecture') {
        console.log(cfg.architecture);
      }
    }
    return;
  }

  if (!directive) {
    // Print repo info (yay uses this to get rootdir, etc.)
    console.log(`Server = ${repo.server}`);
    return;
  }

  const dl = directive.toLowerCase();
  if (dl === 'server') console.log(repo.server);
  else if (dl === 'type') console.log(repo.type || 'debian');
  else if (dl === 'dist') console.log(repo.dist || '');
  else if (dl === 'architecture') console.log(repo.architecture || cfg.architecture);
}

main();
