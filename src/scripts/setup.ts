#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';

const CONFIG_DIR = '/etc/pacman-debian';
const CONFIG_PATH = path.join(CONFIG_DIR, 'pacman.conf');
const SYMLINK_PATH = '/etc/pacman';
const DPKG_STATUS = '/var/lib/dpkg/status';

function getPacmanVersion(): string {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.pacmanVersion || '7.1.0';
  } catch { return '7.1.0'; }
}

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
    console.log(':: pacman-debian setup');
    console.log('');
    console.log('  This script needs root to create symlinks and config files.');
    console.log('  Run with sudo:');
    console.log('    sudo npm run setup');
    console.log('    sudo pacman-debian-setup');
    console.log('');
    return;
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

  // --- Symlink /etc/pacman.conf → /etc/pacman-debian/pacman.conf ---
  const pacmanConfLink = '/etc/pacman.conf';
  const confLinkExists = fs.existsSync(pacmanConfLink);
  if (confLinkExists) {
    try {
      const stat = fs.lstatSync(pacmanConfLink);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(pacmanConfLink);
        if (target === CONFIG_PATH) {
          console.log(`  ${pacmanConfLink} → ${CONFIG_PATH} already exists`);
        } else {
          console.log(`  ${pacmanConfLink} exists but points to ${target} (not ${CONFIG_PATH})`);
        }
      } else {
        console.log(`  ${pacmanConfLink} exists as a real file, skipping symlink`);
      }
    } catch { 
      console.log(`  ${pacmanConfLink} check failed`);
    }
  } else {
    if (await ask(`Create symlink ${pacmanConfLink} → ${CONFIG_PATH}?`, true)) {
      fs.symlinkSync(CONFIG_PATH, pacmanConfLink);
      console.log(`  Created: ${pacmanConfLink} → ${CONFIG_PATH}`);
    }
  }

  // --- Default config ---
  if (!fs.existsSync(CONFIG_PATH)) {
    if (await ask('Create default pacman.conf?', true)) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const isDebian = fs.existsSync('/etc/debian_version');
      const content = [
        `# pacman-debian configuration file`,
        `#`,
        `# See /etc/pacman.d/ for mirrorlist examples`,
        ``,
        `[options]`,
        `Architecture = ${arch}`,
        ``,
      ];

      if (isDebian) {
        content.push(
          `# Include = /etc/pacman.d/debian-bookworm`,
          `# Include = /etc/pacman.d/debian-updates`,
          `# Include = /etc/pacman.d/debian-security`,
        );
      }

      content.push(
        `# Include = /etc/pacman.d/mirrorlist`,
        '',
      );

      // Create example include file
      const includeDir = '/etc/pacman.d';
      if (!fs.existsSync(includeDir)) fs.mkdirSync(includeDir, { recursive: true });

      const exampleDebian = path.join(includeDir, 'debian-bookworm');
      if (!fs.existsSync(exampleDebian)) {
        fs.writeFileSync(exampleDebian, [
          `# Debian Bookworm mirror (清华镜像)`,
          `Server = https://mirrors.tuna.tsinghua.edu.cn/debian`,
          `Type = debian`,
          `Dist = bookworm`,
          `Components = main contrib non-free non-free-firmware`,
          ``,
        ].join('\n'));
        console.log(`  Created: ${exampleDebian}`);
      }

      const exampleArch = path.join(includeDir, 'arch-core');
      if (!fs.existsSync(exampleArch)) {
        fs.writeFileSync(exampleArch, [
          `# Arch Linux ARM core mirror`,
          `Server = http://mirror.archlinuxarm.org/$arch/$repo`,
          `Type = arch`,
          `Architecture = aarch64`,
          ``,
        ].join('\n'));
        console.log(`  Created: ${exampleArch}`);
      }
      fs.writeFileSync(CONFIG_PATH, content.join('\n'));
      console.log(`  Created: ${CONFIG_PATH}`);
    }
  } else {
    console.log(`  ${CONFIG_PATH} already exists`);
  }

  // --- Global symlinks for pacman and makepkg ---
  const projectDir = path.resolve(__dirname, '../..');
  const commands: [string, string][] = [
    ['pacman', path.join(projectDir, 'dist', 'index.js')],
    ['makepkg', path.join(projectDir, 'dist', 'makepkg', 'index.js')],
    ['pacman-conf', path.join(projectDir, 'dist', 'scripts', 'pacman-conf.js')],
  ];

  for (const [name, target] of commands) {
    const linkPath = `/usr/local/bin/${name}`;
    const exists = fs.existsSync(linkPath);
    if (exists) {
      try {
        const existing = fs.readlinkSync(linkPath);
        if (existing === target) {
          console.log(`  ${linkPath} → ${target} already exists`);
        } else {
          console.log(`  ${linkPath} exists but points to ${existing}`);
          if (await ask(`  Relink ${linkPath} → ${target}?`, true)) {
            fs.unlinkSync(linkPath);
            fs.symlinkSync(target, linkPath);
            console.log(`  Relinked: ${linkPath} → ${target}`);
          }
        }
      } catch {
        console.log(`  ${linkPath} is not a symlink, skipping`);
      }
    } else {
      if (await ask(`Create symlink ${linkPath} → ${target}?`, true)) {
        fs.symlinkSync(target, linkPath);
        console.log(`  Created: ${linkPath} → ${target}`);
      }
    }
  }

  // --- Build and install libalpm (C library for AUR helpers) ---
  const libDir = path.join(projectDir, 'lib', 'pac4deb');
  if (fs.existsSync(path.join(libDir, 'Makefile'))) {
    if (await ask('Build and install libalpm.so (required for yay/expac)?', true)) {
      try {
        execSync(`make -C "${libDir}"`, { stdio: 'pipe', timeout: 30000 });
        execSync(`make -C "${libDir}" install`, { stdio: 'pipe', timeout: 10000 });
        // Create versioned symlink (expac etc. look for libalpm.so.16)
        const so16 = '/usr/local/lib/libalpm.so.16';
        if (!fs.existsSync(so16)) {
          fs.symlinkSync('libalpm.so', so16);
        }
        execSync('/sbin/ldconfig', { stdio: 'pipe' });
        console.log('  libalpm.so built and installed to /usr/local/lib/');
      } catch (e: any) {
        console.error('  Warning: libalpm build failed:', e.message);
      }
    }
  }

  // --- Virtual pacman package for AUR tool compatibility ---
  const pacVersion = getPacmanVersion();
  const hasPacmanPkg = fs.existsSync(DPKG_STATUS) &&
    fs.readFileSync(DPKG_STATUS, 'utf8').includes('\nPackage: pacman\n');

  if (!hasPacmanPkg) {
    if (await ask(`Create virtual pacman package (v${pacVersion}) in dpkg status?`, true)) {
      const entry = [
        `Package: pacman`,
        `Status: install ok installed`,
        `Priority: optional`,
        `Section: base`,
        `Installed-Size: 1`,
        `Maintainer: pacman-debian`,
        `Architecture: ${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
        `Version: ${pacVersion}`,
        `Description: Virtual package provided by pacman-debian`,
        ``,
      ].join('\n');
      fs.appendFileSync(DPKG_STATUS, '\n' + entry);
      // Also create .list file to suppress dpkg warnings
      const infoDir = '/var/lib/dpkg/info';
      if (fs.existsSync(infoDir)) {
        fs.writeFileSync(`${infoDir}/pacman.list`, '/usr/local/bin/pacman\n');
      }
      console.log(`  Created virtual pacman package v${pacVersion} in dpkg status`);
    }
  } else {
    console.log(`  Virtual pacman package already exists in dpkg status`);
  }

  // --- Virtual package mappings (Arch → Debian) ---
  const pkgMappings: Record<string, { pkg: string; ver?: string }> = {
    'glibc':    { pkg: 'libc6', ver: '2.36' },
    'gcc-libs': { pkg: 'libgcc-s1', ver: '12.2' },
    'gcc':      { pkg: 'gcc', ver: '12.2' },
    'libstdc++':{ pkg: 'libstdc++6', ver: '12.2' },
    'zlib':     { pkg: 'zlib1g', ver: '1:1.2.13' },
    'openssl':  { pkg: 'libssl3', ver: '3.0' },
    'libssl':   { pkg: 'libssl3', ver: '3.0' },
    'libcrypt': { pkg: 'libcrypt1', ver: '1:4.4.33' },
    'libcurl':  { pkg: 'libcurl4', ver: '7.88' },
    'libpcre':  { pkg: 'libpcre3', ver: '2:8.39' },
    'libpcre2': { pkg: 'libpcre2-8-0', ver: '10.42' },
    'libffi':   { pkg: 'libffi8', ver: '3.4.4' },
  };

  // Create pkgmap.json
  const pkgmapPath = path.join(CONFIG_DIR, 'pkgmap.json');
  const existingMap: Record<string, any> = {};
  if (fs.existsSync(pkgmapPath)) {
    try { Object.assign(existingMap, JSON.parse(fs.readFileSync(pkgmapPath, 'utf8'))); } catch {}
  }
  const mergedMap = { ...pkgMappings, ...existingMap };
  fs.writeFileSync(pkgmapPath, JSON.stringify(mergedMap, null, 2) + '\n');

  // Create virtual dpkg entries for mapped packages
  const dpkgStatus = fs.readFileSync(DPKG_STATUS, 'utf8');
  let added = 0;
  for (const [archName, deb] of Object.entries(mergedMap)) {
    if (!dpkgStatus.includes(`\nPackage: ${archName}\n`)) {
      // Only create virtual entry if the mapped Debian pkg is actually installed
      if (dpkgStatus.includes(`\nPackage: ${deb.pkg}\n`)) {
        const entry = [
          `Package: ${archName}`,
          `Status: install ok installed`,
          `Priority: optional`,
          `Section: virtual`,
          `Installed-Size: 1`,
          `Maintainer: pacman-debian`,
          `Architecture: ${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
          `Version: ${deb.ver || '1.0'}`,
          `Description: Virtual package provided by pacman-debian (maps to ${deb.pkg})`,
          ``,
        ].join('\n');
        fs.appendFileSync(DPKG_STATUS, '\n' + entry);
        // Create empty .list file to suppress dpkg warnings
        const listPath = `/var/lib/dpkg/info/${archName}.list`;
        if (!fs.existsSync(listPath)) fs.writeFileSync(listPath, '');
        added++;
      }
    }
  }
  if (added > 0) console.log(`  Created ${added} virtual package mappings in dpkg status`);

  console.log('');
  console.log(':: Setup complete');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit /etc/pacman-debian/pacman.conf to add your repositories');
  console.log('  2. Run sudo pacman -Sy to sync');
  console.log('  3. Run sudo pacman -S <package> to install');
  console.log('  4. Run makepkg in a directory with PKGBUILD to build packages');
  console.log('  5. For AUR helper support, build and install libalpm:');
  console.log('       cd lib/pac4deb && make && sudo make install');
}

main().catch(e => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
