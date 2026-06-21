#!/usr/bin/env node
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

function getJvmDir(): string {
  return '/usr/lib/jvm';
}

function listJvms(): string[] {
  const dir = getJvmDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(d => {
    const javaBin = `${dir}/${d}/bin/java`;
    return fs.existsSync(javaBin) || fs.existsSync(javaBin + '.exe');
  });
}

function getCurrentJava(): string | null {
  try {
    const link = fs.readlinkSync('/etc/alternatives/java');
    const parts = link.split('/');
    const jvmIdx = parts.indexOf('jvm');
    if (jvmIdx >= 0 && jvmIdx + 1 < parts.length) return parts[jvmIdx + 1];
    // Fallback: find by matching /usr/lib/jvm/
    for (const dir of listJvms()) {
      if (link.includes(dir)) return dir;
    }
    return null;
  } catch {
    return null;
  }
}

function setJava(name: string): void {
  const dir = `${getJvmDir()}/${name}`;
  const javaBin = `${dir}/bin/java`;
  if (!fs.existsSync(javaBin)) {
    console.error(`error: '${name}' is not a valid Java environment`);
    process.exit(1);
  }
  execSync(`update-alternatives --install /usr/bin/java java ${javaBin} 25000`, { stdio: 'pipe' });
  execSync(`update-alternatives --set java ${javaBin}`, { stdio: 'pipe' });
  console.log(`'${name}' has been set as the default Java environment`);
}

function unsetJava(): void {
  try {
    execSync('update-alternatives --remove java /usr/lib/jvm/*/bin/java', { stdio: 'pipe' });
  } catch {}
}

function fixDefault(): string | null {
  const current = getCurrentJava();
  if (current && listJvms().includes(current)) return current;

  const jvms = listJvms();
  if (jvms.length === 0) return null;

  // Set first available JVM as default
  setJava(jvms[0]);
  return jvms[0];
}

function cmdStatus(): void {
  const jvms = listJvms();
  const current = getCurrentJava();
  console.log('Available Java environments:');
  for (const j of jvms) {
    const marker = j === current ? ' (default)' : '';
    console.log(`  ${j}${marker}`);
  }
}

function cmdGet(): void {
  const current = getCurrentJava();
  if (current) console.log(current);
  else process.exit(1);
}

function help(): void {
  console.log(`Usage: archlinux-java [options]

Commands:
  archlinux-java status      List installed Java environments
  archlinux-java get         Print current default Java environment
  archlinux-java set <name>  Set default Java environment
  archlinux-java unset       Unset current default Java environment
  archlinux-java fix         Fix broken default Java environment
  archlinux-java help        Show this help`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') { help(); return; }

  switch (args[0]) {
    case 'status': cmdStatus(); break;
    case 'get': cmdGet(); break;
    case 'set':
      if (!args[1]) { console.error('error: missing argument for set'); process.exit(1); }
      setJava(args[1]);
      break;
    case 'unset':
      if (process.getuid && process.getuid() !== 0) { console.error('error: must be root'); process.exit(1); }
      unsetJava();
      break;
    case 'fix':
      if (process.getuid && process.getuid() !== 0) { console.error('error: must be root'); process.exit(1); }
      fixDefault();
      break;
    default:
      console.error(`error: unknown subcommand '${args[0]}'`);
      process.exit(1);
  }
}

main();
