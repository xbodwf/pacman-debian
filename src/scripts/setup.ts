#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync, execSync } from 'node:child_process';
import { scopedT } from '../i18n';
import { acquireDpkgLock, releaseDpkgLock } from '../lock/dpkg-lock';

const t = scopedT('setup');

const CONFIG_DIR = '/etc/pacman-debian';
const CONFIG_PATH = path.join(CONFIG_DIR, 'pacman.conf');
const SYMLINK_PATH = '/etc/pacman';
const DPKG_STATUS = '/var/lib/dpkg/status';
const PACMAN_DB_SYMLINK = '/var/lib/pacman';
const PACMAN_DB_TARGET = '/var/lib/pacman-debian';

function ensureDpkgHelper(projectDir: string): void {
  const helperDir = path.join(projectDir, 'dist', 'lock');
  const helperPath = path.join(helperDir, 'dpkg-helper');
  if (fs.existsSync(helperPath)) {
    fs.chmodSync(helperPath, 0o755);
    fs.accessSync(helperPath, fs.constants.X_OK);
    console.log(`Executable helper ready: ${helperPath}`);
    return;
  }

  const sourcePath = path.join(projectDir, 'src', 'lock', 'dpkg-helper.c');
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`dpkg-helper is missing: ${helperPath}`);
  }
  fs.mkdirSync(helperDir, { recursive: true });
  execFileSync('gcc', ['-O2', '-s', '-o', helperPath, sourcePath], { stdio: 'pipe', timeout: 30000 });
  fs.chmodSync(helperPath, 0o755);
  fs.accessSync(helperPath, fs.constants.X_OK);
  console.log(`Built ${helperPath}`);
}

function getPacmanVersion(): string {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.pacmanVersion || '7.1.0';
  } catch { return '7.1.0'; }
}

async function ask(key: string, ...args: (string | number)[]): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(t(key, ...args) + ' ', answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(true);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function needRootSection(): void {
  console.log(t('setup_banner'));
  console.log('');
  console.log(t('need_root_detail'));
}

async function handleLink(linkPath: string, target: string): Promise<void> {
  const exists = fs.existsSync(linkPath);
  if (exists) {
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(linkPath);
        if (existing === target) {
          console.log(t('setup_symlink_exists', linkPath));
          return;
        }
        console.log(t('setup_symlink_wrong_target', linkPath, existing, target));
        if (!await ask('prompt_relink', linkPath, target)) return;
        fs.unlinkSync(linkPath);
      } else {
        console.log(t('setup_symlink_not_symlink', linkPath));
        return;
      }
    } catch {
      console.log(t('setup_symlink_check_failed', linkPath));
      return;
    }
  } else {
    if (!await ask('prompt_create_symlink', linkPath, target)) return;
  }
  fs.symlinkSync(target, linkPath);
  console.log(t('setup_symlink_created', linkPath, target));
}

async function main() {
  if (process.getuid && process.getuid() !== 0) {
    needRootSection();
    return;
  }

  console.log(t('setup_banner'));
  console.log('');

  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // --- Symlink /etc/pacman → /etc/pacman-debian ---
  await handleLink(SYMLINK_PATH, CONFIG_DIR);

  // --- Symlink /etc/pacman.conf -> /etc/pacman-debian/pacman.conf ---
  await handleLink('/etc/pacman.conf', CONFIG_PATH);

  // --- Default config ---
  if (!fs.existsSync(CONFIG_PATH)) {
    if (await ask('prompt_create_default_config')) {
      const templatePath = path.resolve(__dirname, '../../resources/pacman.conf.template');
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, CONFIG_PATH);
      } else {
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const content = [
          `[options]`,
          `Architecture = ${arch}`,
          `ParallelDownloads = 5`,
          `Color`,
          `SigLevel = Never`,
          `LocalFileSigLevel = Optional`,
          ``,
        ];
        fs.writeFileSync(CONFIG_PATH, content.join('\n'));
      }
      console.log(t('setup_config_created', CONFIG_PATH));

      const includeDir = '/etc/pacman.d';
      if (!fs.existsSync(includeDir)) fs.mkdirSync(includeDir, { recursive: true });

      const exampleDebian = path.join(includeDir, 'debian-bookworm');
      if (!fs.existsSync(exampleDebian)) {
        fs.writeFileSync(exampleDebian, [
          `# Debian Bookworm mirror`,
          `Server = https://mirrors.tuna.tsinghua.edu.cn/debian`,
          `Type = debian`,
          `Dist = bookworm`,
          `Components = main contrib non-free non-free-firmware`,
          ``,
        ].join('\n'));
        console.log(t('setup_include_created', exampleDebian));
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
        console.log(t('setup_include_created', exampleArch));
      }
    }
  } else {
    console.log(t('setup_config_exists', CONFIG_PATH));
  }

  // --- Copy paclink source configuration if missing ---
  const paclinkConfigTarget = '/etc/pacman-debian/paclink.conf';
  if (!fs.existsSync(paclinkConfigTarget)) {
    const paclinkConfigSource = path.resolve(__dirname, '../../resources/paclink.conf');
    if (fs.existsSync(paclinkConfigSource)) {
      fs.copyFileSync(paclinkConfigSource, paclinkConfigTarget);
      console.log(`Created ${paclinkConfigTarget}`);
    }
  }
  // --- Ask to add multilib repo ---
  const multilibPath = '/etc/pacman.d/multilib';
  const multilibSection = '[multilib]';
  const hasMultilib = fs.existsSync(CONFIG_PATH) &&
    fs.readFileSync(CONFIG_PATH, 'utf8').includes(multilibSection);

  if (!hasMultilib && await ask('prompt_add_multilib')) {
    try {
      const includeDir = '/etc/pacman.d';
      if (!fs.existsSync(includeDir)) fs.mkdirSync(includeDir, { recursive: true });
      if (!fs.existsSync(multilibPath)) {
        fs.writeFileSync(multilibPath, [
          `# Multilib mirror (x86_64 32-bit compatibility)`,
          `Server = https://mirrors.tuna.tsinghua.edu.cn/archlinux/\$repo/os/\$arch`,
          `Type = arch`,
          `Architecture = x86_64`,
          ``,
        ].join('\n'));
      }
      fs.appendFileSync(CONFIG_PATH, `\n[multilib]\nInclude = ${multilibPath}\n`);
      console.log('Added [multilib] repository to pacman.conf');
    } catch (e: any) {
      console.error(`Failed to add multilib: ${e.message}`);
    }
  }

  // --- Symlink /var/lib/pacman -> /var/lib/pacman-debian ---
  if (!fs.existsSync(PACMAN_DB_SYMLINK)) {
    try {
      fs.symlinkSync(PACMAN_DB_TARGET, PACMAN_DB_SYMLINK);
      console.log(t('setup_symlink_created', PACMAN_DB_SYMLINK, PACMAN_DB_TARGET));
    } catch (e: any) {
      console.error(t('error_prefix', e.message));
    }
  } else {
    try {
      const stat = fs.lstatSync(PACMAN_DB_SYMLINK);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(PACMAN_DB_SYMLINK);
        if (existing !== PACMAN_DB_TARGET) {
          console.log(t('setup_symlink_wrong_target', PACMAN_DB_SYMLINK, existing, PACMAN_DB_TARGET));
          fs.unlinkSync(PACMAN_DB_SYMLINK);
          fs.symlinkSync(PACMAN_DB_TARGET, PACMAN_DB_SYMLINK);
          console.log(t('setup_symlink_created', PACMAN_DB_SYMLINK, PACMAN_DB_TARGET));
        } else {
          console.log(t('setup_symlink_exists', PACMAN_DB_SYMLINK));
        }
      } else {
        console.log(t('setup_symlink_not_symlink', PACMAN_DB_SYMLINK));
      }
    } catch (e: any) {
      console.error(t('error_prefix', e.message));
    }
  }

  // Ensure /var/lib/pacman-debian/local exists for fastfetch detection
  const localDir = path.join(PACMAN_DB_TARGET, 'local');
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  // --- Arch-compat profile functions (append_path, etc.) ---
  const profileCompat = '/etc/profile.d/append_path.sh';
  if (!fs.existsSync(profileCompat)) {
    fs.writeFileSync(profileCompat, [
      'append_path() {',
      '    case ":${PATH}:" in',
      '        *:"$1":*) ;;',
      '        *) PATH="${PATH:+$PATH:}$1" ;;',
      '    esac',
      '}',
      'export PATH',
      '',
    ].join('\n'));
    fs.chmodSync(profileCompat, 0o644);
    console.log(`Created ${profileCompat}`);
  }

  // --- Global symlinks ---
  const projectDir = path.resolve(__dirname, '../..');
  const commands: [string, string][] = [
    ['pacman', path.join(projectDir, 'dist', 'index.js')],
    ['pacmigrate', path.join(projectDir, 'dist', 'cli', 'pacmigrate.js')],
    ['makepkg', path.join(projectDir, 'dist', 'makepkg', 'index.js')],
    ['pacman-conf', path.join(projectDir, 'dist', 'scripts', 'pacman-conf.js')],
    ['paclink', path.join(projectDir, 'dist', 'cli', 'paclink.js')],
    ['update-ca-trust', path.join(projectDir, 'dist', 'cli', 'update-ca-trust.js')],
    ['archlinux-java', path.join(projectDir, 'dist', 'cli', 'archlinux-java.js')],
    ['fix_default', path.join(projectDir, 'dist', 'cli', 'fix_default.js')],
    ['pactree', path.join(projectDir, 'dist', 'cli', 'pactree.js')],
  ];

  for (const [name, target] of commands) {
    try { fs.chmodSync(target, 0o755); } catch (e: any) { console.error(`Failed to make ${target} executable: ${e.message}`); }
    await handleLink(`/usr/local/bin/${name}`, target);
  }

  // Also link Arch-compat tools to /usr/bin/ for package install scripts
  const archCompat = ['update-ca-trust', 'archlinux-java', 'fix_default', 'pactree'];
  for (const name of archCompat) { await handleLink(`/usr/bin/${name}`, `/usr/local/bin/${name}`); }

  // --- Build the dpkg lock helper before any package transaction can run ---
  ensureDpkgHelper(projectDir);

  // --- Build and install libalpm ---
  const libDir = path.join(projectDir, 'lib', 'pac4deb');
  if (fs.existsSync(path.join(libDir, 'Makefile'))) {
    if (await ask('prompt_lib_build')) {
      try {
        execSync(`make -C "${libDir}"`, { stdio: 'pipe', timeout: 30000 });
        execSync(`make -C "${libDir}" install`, { stdio: 'pipe', timeout: 10000 });
        const so16 = '/usr/local/lib/libalpm.so.16';
        if (!fs.existsSync(so16)) fs.symlinkSync('libalpm.so', so16);
        execSync('/sbin/ldconfig', { stdio: 'pipe' });
        console.log(t('prompt_lib_built'));
      } catch (e: any) {
        console.error(t('prompt_lib_failed', e.message));
      }
    }
  }

  // --- Virtual pacman package ---
  const pacVersion = getPacmanVersion();
  const dpkgStatus = fs.existsSync(DPKG_STATUS) ? fs.readFileSync(DPKG_STATUS, 'utf8') : '';
  const pacmanEntry = dpkgStatus.split('\n\n').find(entry => /^Package: pacman$/m.test(entry));
  const hasVirtualPacman = !!pacmanEntry && pacmanEntry.includes('Description: Virtual package provided by pacman-debian');
  const isGamePacman = !!pacmanEntry && !hasVirtualPacman && /Description: Chase Monsters in a Labyrinth/m.test(pacmanEntry);

  if (isGamePacman && await ask('prompt_replace_game_pacman')) {
    try {
      // Force removal is needed because APT helpers depend on the package name.
      // The virtual replacement is written immediately below in the same setup.
      execSync('dpkg --remove --force-depends pacman', { stdio: 'inherit', timeout: 60000 });
    } catch (e: any) {
      console.error(t('prompt_replace_game_pacman_failed', e.message));
    }
  }

  const currentStatus = fs.existsSync(DPKG_STATUS) ? fs.readFileSync(DPKG_STATUS, 'utf8') : '';
  const hasPacmanPkg = currentStatus.split('\n\n').some(entry => /^Package: pacman$/m.test(entry));
  if (!hasPacmanPkg) {
    if (await ask('prompt_virtual_pacman', pacVersion)) {
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
      await acquireDpkgLock();
      try { fs.appendFileSync(DPKG_STATUS, '\n' + entry); } finally { releaseDpkgLock(); }
      const infoDir = '/var/lib/dpkg/info';
      if (fs.existsSync(infoDir)) fs.writeFileSync(`${infoDir}/pacman.list`, '/usr/local/bin/pacman\n');
      console.log(t('prompt_virtual_pacman_created', pacVersion));
    }
  } else {
    console.log(t('prompt_virtual_pacman_exists'));
  }

  console.log('');
  console.log(t('setup_complete'));
  console.log('');
  console.log(t('setup_next_steps'));
  console.log(t('setup_next_step_1'));
  console.log(t('setup_next_step_2'));
  console.log(t('setup_next_step_3'));
  console.log(t('setup_next_step_4'));
  console.log(t('setup_next_step_5'));
}

main().catch(e => {
  console.error(t('error_prefix', e.message));
  process.exit(1);
});
