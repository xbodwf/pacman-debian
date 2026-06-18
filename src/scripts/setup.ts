#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const CONFIG_DIR = '/etc/pacman-debian';
const CONFIG_PATH = path.join(CONFIG_DIR, 'pacman.conf');
const SYMLINK_PATH = '/etc/pacman';

function ask(query: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise(resolve => {
    rl.question(`${query} ${suffix} `, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

async function main() {
  if (process.getuid && process.getuid() !== 0) {
    console.error('error: setup must be run as root (sudo)');
    process.exit(1);
  }

  console.log(':: pacman-debian setup\n');

  // Ensure data directories exist
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // --- Symlink /etc/pacman → /etc/pacman-debian ---
  const linkExists = fs.existsSync(SYMLINK_PATH);
  if (linkExists) {
    const stat = fs.lstatSync(SYMLINK_PATH);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(SYMLINK_PATH);
      if (target === CONFIG_DIR) {
        console.log(`  ${SYMLINK_PATH} → ${CONFIG_DIR} already exists`);
      } else {
        console.log(`  ${SYMLINK_PATH} exists but points to ${target} (not ${CONFIG_DIR})`);
      }
    } else {
      console.log(`  ${SYMLINK_PATH} exists as a directory/file, skipping symlink`);
    }
  } else {
    if (await ask(`Create symlink ${SYMLINK_PATH} → ${CONFIG_DIR}?`, true)) {
      fs.symlinkSync(CONFIG_DIR, SYMLINK_PATH);
      console.log(`  Created: ${SYMLINK_PATH} → ${CONFIG_DIR}`);
    }
  }

  // --- Default config ---
  if (!fs.existsSync(CONFIG_PATH)) {
    if (await ask('Create default pacman.conf?', true)) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const isDebian = fs.existsSync('/etc/debian_version');
      const content = [
        `# pacman-debian configuration file`,
        ``,
        `[options]`,
        `Architecture = ${arch}`,
        ``,
      ];

      if (isDebian) {
        content.push(
          `# ... add Debian/Ubuntu repos here ...`,
          `#`,
          `# [bookworm]`,
          `# Type = debian`,
          `# Server = https://mirrors.tuna.tsinghua.edu.cn/debian`,
          `# Dist = bookworm`,
          `# Components = main contrib non-free non-free-firmware`,
          ``,
          `# [core]`,
          `# Type = arch`,
          `# Server = http://mirror.archlinuxarm.org/$arch/$repo`,
          `# Architecture = aarch64`,
        );
      } else {
        content.push(
          `# [core]`,
          `# Include = /etc/pacman.d/mirrorlist`,
        );
      }

      content.push('');
      fs.writeFileSync(CONFIG_PATH, content.join('\n'));
      console.log(`  Created: ${CONFIG_PATH}`);
    }
  } else {
    console.log(`  ${CONFIG_PATH} already exists`);
  }

  console.log('');
  console.log(':: Setup complete');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit /etc/pacman-debian/pacman.conf to add your repositories');
  console.log('  2. Run sudo pacman -Sy to sync');
  console.log('  3. Run sudo pacman -S <package> to install');
}

main().catch(e => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
