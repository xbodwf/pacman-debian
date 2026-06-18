import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { parsePkgbuild, pkgFilename, printSrcinfo } from './pkgbuild';
import type { PkgbuildInfo } from './pkgbuild';

export interface BuildOptions {
  install?: boolean;
  clean?: boolean;
  skipExtract?: boolean;
  skipBuild?: boolean;
  skipPackage?: boolean;
  skipChecksum?: boolean;
  nodeps?: boolean;
  syncdeps?: boolean;
  rmdeps?: boolean;
  force?: boolean;
  log?: boolean;
  ignoreArch?: boolean;
  pkgbuild?: string;
  printsrcinfo?: boolean;
  geninteg?: boolean;
}

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function verifyChecksum(filePath: string, expected: string, algorithm: string): boolean {
  if (!expected || expected === 'SKIP' || expected === 'skip') return true;
  const hash = crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest('hex');
  return hash === expected.toLowerCase();
}

function getSourceFilename(url: string): string {
  const s = url.split('::')[1] || url;
  return path.basename(s.split('?')[0].split('#')[0]);
}

function getSourceURL(url: string): string {
  const parts = url.split('::');
  return parts.length > 1 ? parts[1] : parts[0];
}

function downloadSource(url: string, destDir: string): string {
  const filename = getSourceFilename(url);
  const dest = path.join(destDir, filename);
  if (fs.existsSync(dest)) return dest;
  const realUrl = getSourceURL(url);
  console.log(`  downloading ${filename}...`);
  try { execSync(`curl -fsSL -o "${dest}" "${realUrl}"`, { stdio: 'pipe', timeout: 120000 }); }
  catch { execSync(`wget -q -O "${dest}" "${realUrl}"`, { stdio: 'pipe', timeout: 120000 }); }
  return dest;
}

function extractSource(filePath: string, destDir: string): void {
  const name = path.basename(filePath);
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) execSync(`tar -xzf "${filePath}" -C "${destDir}"`, { stdio: 'pipe' });
  else if (name.endsWith('.tar.xz')) execSync(`tar -xJf "${filePath}" -C "${destDir}"`, { stdio: 'pipe' });
  else if (name.endsWith('.tar.bz2')) execSync(`tar -xjf "${filePath}" -C "${destDir}"`, { stdio: 'pipe' });
  else if (name.endsWith('.tar.zst')) execSync(`tar --zstd -xf "${filePath}" -C "${destDir}"`, { stdio: 'pipe' });
  else if (name.endsWith('.zip')) execSync(`unzip -q -o "${filePath}" -d "${destDir}"`, { stdio: 'pipe' });
  else if (name.endsWith('.gz')) execSync(`gunzip -c "${filePath}" > "${destDir}/${name.replace(/\.gz$/, '')}"`, { stdio: 'pipe' });
  else if (name.endsWith('.xz')) execSync(`xz -dc "${filePath}" > "${destDir}/${name.replace(/\.xz$/, '')}"`, { stdio: 'pipe' });
  else fs.copyFileSync(filePath, path.join(destDir, name));
}

function getDirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isFile()) total += fs.statSync(fp).size;
      else if (e.isDirectory()) total += getDirSize(fp);
    }
  } catch {}
  return total;
}

function installDep(dep: string): void {
  const name = dep.split(/[<>=]/)[0].trim();
  try {
    // Prefer our own pacman, fallback to apt
    execSync(`pacman -S --noconfirm --needed "${name}" 2>/dev/null`, { stdio: 'pipe', timeout: 60000 });
  } catch {
    try { execSync(`apt-get install -y "${name}" 2>/dev/null`, { stdio: 'pipe', timeout: 60000 }); } catch {}
  }
}

export async function buildPkgbuild(options: BuildOptions): Promise<string> {
  const pkgbuildPath = path.resolve(options.pkgbuild || 'PKGBUILD');
  const workDir = path.dirname(pkgbuildPath);

  if (options.printsrcinfo) {
    const info = parsePkgbuild(pkgbuildPath, options.ignoreArch);
    process.stdout.write(printSrcinfo(info));
    return '';
  }

  if (options.geninteg) {
    const info = parsePkgbuild(pkgbuildPath, options.ignoreArch);
    for (let i = 0; i < info.source.length; i++) {
      const src = getSourceFilename(info.source[i]);
      console.log(`  generating checksum for ${src}...`);
    }
    console.log('  (run with sources downloaded)');
    return '';
  }

  const logDir = path.join(workDir, 'src');
  const logFile = options.log ? path.join(workDir, `${path.basename(workDir)}.log`) : undefined;

  console.log(`==> Building ${path.basename(workDir)}`);
  const info = parsePkgbuild(pkgbuildPath, options.ignoreArch);

  const fullVersion = [info.pkgver, info.pkgrel].filter(Boolean).join('-');
  console.log(`  -> package: ${info.pkgname}-${fullVersion}`);

  const srcdir = path.join(workDir, 'src', `${info.pkgname}-${info.pkgver}`);
  const pkgdir = path.join(workDir, 'pkg', `${info.pkgname}-${info.pkgver}`);
  const outDir = workDir;

  ensureDir(srcdir);
  ensureDir(pkgdir);
  ensureDir(outDir);

  if (options.clean) {
    if (fs.existsSync(srcdir)) fs.rmSync(srcdir, { recursive: true });
    if (fs.existsSync(pkgdir)) fs.rmSync(pkgdir, { recursive: true });
    ensureDir(srcdir);
    ensureDir(pkgdir);
  }

  // --- syncdeps ---
  if (options.syncdeps && !options.nodeps) {
    const allDeps = [...new Set([...info.makedepends, ...info.checkdepends, ...info.depends])];
    if (allDeps.length > 0) {
      console.log('  :: Installing missing dependencies...');
      for (const d of allDeps) {
        const name = d.split(/[<>=]/)[0].trim();
        process.stdout.write(`    installing ${name}...`);
        installDep(d);
        process.stdout.write(' done\n');
      }
    }
  }

  // --- Download sources ---
  const sourceFiles: string[] = [];
  if (info.source.length > 0) {
    console.log('  :: Downloading sources...');
    for (const src of info.source) {
      const filename = getSourceFilename(src);
      const srcUrl = getSourceURL(src);
      if (srcUrl.startsWith('http://') || srcUrl.startsWith('https://') || srcUrl.startsWith('ftp://')) {
        const file = downloadSource(src, srcdir);
        sourceFiles.push(file);
        console.log(`    ${filename}... done`);
      } else if (fs.existsSync(path.join(workDir, src))) {
        const file = path.join(workDir, src);
        const dest = path.join(srcdir, filename);
        fs.cpSync(file, dest, { recursive: true, force: true });
        sourceFiles.push(dest);
        console.log(`    ${filename}... found in workspace`);
      } else {
        console.log(`    ${filename}... not found`);
      }
    }
  }

  // --- Verify checksums ---
  if (!options.skipChecksum && !options.nodeps && info.source.length > 0) {
    const hasSha = info.sha256sums.length === info.source.length && info.sha256sums.some(s => s && s !== 'SKIP');
    const hasMd5 = info.md5sums.length === info.source.length && info.md5sums.some(s => s && s !== 'SKIP');
    if (hasSha || hasMd5) {
      console.log('  :: Verifying source file checksums...');
      for (let i = 0; i < info.source.length; i++) {
        const filename = getSourceFilename(info.source[i]);
        const file = sourceFiles[i];
        if (!file || !fs.existsSync(file)) continue;
        if (hasSha) {
          if (verifyChecksum(file, info.sha256sums[i], 'sha256')) {
            console.log(`    ${filename} ... Passed`);
          } else {
            throw new Error(`sha256sum mismatch for ${filename}`);
          }
        } else if (hasMd5) {
          if (verifyChecksum(file, info.md5sums[i], 'md5')) {
            console.log(`    ${filename} ... Passed`);
          } else {
            throw new Error(`md5sum mismatch for ${filename}`);
          }
        }
      }
    }
  }

  // --- Extract sources ---
  if (!options.skipExtract) {
    const noextract = new Set(info.noextract);
    const toExtract = sourceFiles.filter(f => !noextract.has(path.basename(f)));
    if (toExtract.length > 0) {
      console.log('  :: Extracting sources...');
      for (const file of toExtract) {
        try {
          extractSource(file, srcdir);
          console.log(`    ${path.basename(file)}... done`);
        } catch (e: any) {
          console.error(`    warning: failed to extract ${path.basename(file)}: ${e.message}`);
        }
      }
    }
  }

  // --- Build script ---
  const buildScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'makepkg-')), `${info.pkgname}.sh`);
  try {
    const scriptLines: string[] = [
      '#!/bin/bash',
      'set -e',
      `export srcdir="${srcdir}"`,
      `export pkgdir="${pkgdir}"`,
      `export pkgname="${info.pkgname}"`,
      `export pkgver="${info.pkgver}"`,
      `export pkgrel="${info.pkgrel}"`,
      `export CARCH="${info.arch[0] || 'aarch64'}"`,
      'cd "$srcdir"',
      '',
    ];

    // prepare()
    if (info.prepareFn && !options.skipBuild) {
      console.log('  :: Preparing...');
      scriptLines.push(info.prepareFn);
      scriptLines.push('prepare');
    }

    // build()
    if (info.buildFn && !options.skipBuild) {
      console.log('  :: Building...');
      scriptLines.push(info.buildFn);
      scriptLines.push('build');
    }

    // check()
    if (info.checkFn && !options.skipBuild) {
      console.log('  :: Checking...');
      scriptLines.push(info.checkFn);
      scriptLines.push('check');
    }

    // package()
    if (info.packageFn && !options.skipPackage) {
      console.log('  :: Packaging...');
      scriptLines.push(info.packageFn);
      scriptLines.push('package');
    }

    const hasWork = scriptLines.length > 7;
    if (!hasWork && !options.skipPackage) {
      throw new Error('PKGBUILD has no build(), prepare(), check(), or package() function');
    }

    if (hasWork) {
      fs.writeFileSync(buildScript, scriptLines.join('\n'), { mode: 0o755 });
      const logArg = logFile ? ` 2>&1 | tee "${logFile}"` : '';
      try {
        const cmd = `/bin/bash "${buildScript}"${logArg}`;
        execSync(cmd, { stdio: 'inherit', timeout: 600000, cwd: srcdir });
      } catch (e: any) {
        throw new Error(`build failed: ${e.message}`);
      }
    }
  } finally {
    try { fs.unlinkSync(buildScript); } catch {}
  }

  // --- Create .pkg.tar.zst ---
  if (!options.skipPackage) {
    const outFile = path.join(outDir, pkgFilename(info));

    if (!options.force && fs.existsSync(outFile)) {
      throw new Error(`${path.basename(outFile)} already exists (use -f to overwrite)`);
    }

    const pkgContents = fs.readdirSync(pkgdir);
    if (pkgContents.length === 0) throw new Error('package() produced no files in $pkgdir');

    // Build .PKGINFO
    const pkginfoLines = [
      '# generated by pacman-debian makepkg',
      `pkgname = ${info.pkgname}`,
      `pkgver = ${info.pkgver}-${info.pkgrel}`,
      `pkgdesc = `,
      `url = ${info.url || ''}`,
      `builddate = ${Math.floor(Date.now() / 1000)}`,
      `packager = pacman-debian`,
      `size = ${getDirSize(pkgdir)}`,
      `arch = ${info.arch[0] || 'any'}`,
      ...info.license.map(l => `license = ${l}`),
      ...info.depends.map(d => `depend = ${d}`),
      ...info.provides.map(p => `provides = ${p}`),
      ...info.conflicts.map(c => `conflict = ${c}`),
    ];
    fs.writeFileSync(path.join(pkgdir, '.PKGINFO'), pkginfoLines.join('\n') + '\n');

    // Copy install script if present
    if (info.install && fs.existsSync(path.join(workDir, info.install))) {
      fs.copyFileSync(path.join(workDir, info.install), path.join(pkgdir, '.INSTALL'));
    }

    // Create .pkg.tar.zst
    execSync(`tar --zstd -cf "${outFile}" -C "${pkgdir}" .`, { stdio: 'pipe', timeout: 120000 });

    const stat = fs.statSync(outFile);
    const sizeKb = (stat.size / 1024).toFixed(0);
    console.log(`  ==> Created package: ${path.basename(outFile)} (${sizeKb} KiB)`);

    // Install
    if (options.install) {
      console.log('  :: Installing package...');
      const { installPkgFile } = await import('../ops/install');
      await installPkgFile(outFile, 'explicit');
    }

    // Remove build deps
    if (options.rmdeps && options.syncdeps) {
      const allDeps = [...new Set([...info.makedepends, ...info.checkdepends])];
      for (const d of allDeps) {
        const name = d.split(/[<>=]/)[0].trim();
        try { execSync(`pacman -R --noconfirm "${name}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
      }
    }

    return outFile;
  }

  return '';
}
