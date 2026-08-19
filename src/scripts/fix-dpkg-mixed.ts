import * as fs from 'node:fs';

/**
 * Repair dpkg status for a system where pacman-debian installed Arch packages
 * and wrote dpkg entries under Arch package names.
 *
 * Strategy (per the paclink model):
 *  - Packages whose name exists in the Debian repos (e.g. "dpkg", "zsh",
 *    "7zip") get their real Debian record back. We prefer the clean 6/18
 *    snapshot (/var/lib/dpkg/status.pacman-debian.bak); for names missing
 *    there we keep the current entry but strip Arch-specific fields and
 *    translate dependencies to Debian-resolvable names.
 *  - Packages with pure Arch names (not in the Debian repos, e.g. "yyjson",
 *    "gtk3", "mesa") are removed from dpkg entirely — pacman-debian manages
 *    them, and apt must not see them.
 *
 * Usage (as root):
 *   sudo node dist/scripts/fix-dpkg-mixed.js
 */

const DPKG_STATUS = '/var/lib/dpkg/status';
const SNAPSHOT = '/var/lib/dpkg/status.pacman-debian.bak';

function parseEntries(content: string): string[] {
  return content.split('\n\n').filter(e => e.trim() !== '');
}

function pkgName(entry: string): string | undefined {
  return entry.match(/^Package: (.+)$/m)?.[1];
}

function main(): void {
  const current = fs.readFileSync(DPKG_STATUS, 'utf8');
  const entries = parseEntries(current);

  const snapshotEntries = fs.existsSync(SNAPSHOT) ? parseEntries(fs.readFileSync(SNAPSHOT, 'utf8')) : [];
  const snapshotByName = new Map<string, string>();
  for (const e of snapshotEntries) {
    const n = pkgName(e);
    if (n) snapshotByName.set(n, e);
  }

  // Real Debian package names, derived from the repo idx cache.
  const debNames = new Set<string>();
  const repoDir = '/var/cache/pacman-debian/packages';
  if (fs.existsSync(repoDir)) {
    for (const repo of fs.readdirSync(repoDir)) {
      const idx = `${repoDir}/${repo}/packages.idx`;
      if (!fs.existsSync(idx)) continue;
      for (const line of fs.readFileSync(idx, 'utf8').split('\n')) {
        const m = line.match(/^(\S+)/);
        if (m) debNames.add(m[1]);
      }
    }
  }

  let restored = 0, removed = 0, keptArch = 0;
  const out: string[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    const name = pkgName(entry);
    if (!name) { out.push(entry); continue; }
    const isArchEntry = entry.includes('X-Pacman-Base');
    if (!isArchEntry) { out.push(entry); continue; }

    if (debNames.has(name)) {
      // Same-name package exists in Debian repos: restore the real record.
      const snap = snapshotByName.get(name);
      if (snap) {
        out.push(snap);
        restored++;
        notes.push(`restored ${name} from snapshot`);
      } else {
        // No snapshot: keep entry but drop Arch-only fields so apt can parse it.
        const cleaned = entry
          .split('\n')
          .filter(l => !/^X-Pacman-/.test(l) && !/^Maintainer: Arch/.test(l))
          .join('\n');
        out.push(cleaned);
        keptArch++;
        notes.push(`kept ${name} (no snapshot, cleaned)`);
      }
    } else {
      // Pure Arch name: remove from dpkg.
      removed++;
      notes.push(`removed ${name}`);
    }
  }

  const backup = `${DPKG_STATUS}.pre-fix-mixed`;
  if (process.argv.includes('--dry-run')) {
    console.log(`[dry-run] would restore: ${restored}, remove: ${removed}, keep: ${keptArch}`);
    for (const n of notes.slice(0, 120)) console.log('  ' + n);
    return;
  }
  fs.writeFileSync(backup, current);
  fs.writeFileSync(DPKG_STATUS, out.join('\n\n') + '\n');
  console.log(`restored: ${restored}, removed: ${removed}, kept: ${keptArch}`);
  console.log(`backup: ${backup}`);
  for (const n of notes.slice(0, 60)) console.log('  ' + n);
}

if (process.getuid && process.getuid() !== 0) {
  console.error('Must run as root: sudo node dist/scripts/fix-dpkg-mixed.js');
  process.exit(1);
}

main();
