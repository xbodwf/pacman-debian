import * as fs from 'node:fs';

const PACLINKS_FILE = '/var/lib/pacman-debian/paclinks';

export interface PaclinkEntry {
  virt: string;
  deb: string;
}

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

export function readPaclinks(): PaclinkEntry[] {
  if (!fs.existsSync(PACLINKS_FILE)) return [];
  const text = fs.readFileSync(PACLINKS_FILE, 'utf8');
  return text.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const [virt, deb] = line.trim().split(/\s+/, 2);
      return { virt, deb };
    });
}

export function writePaclinks(entries: PaclinkEntry[]): void {
  entries.sort((a, b) => a.virt.localeCompare(b.virt));
  const text = entries.map(e => `${e.virt} ${e.deb}`).join('\n') + '\n';
  ensureDir('/var/lib/pacman-debian');
  fs.writeFileSync(PACLINKS_FILE, text, 'utf8');
}

export function addPaclink(virt: string, deb: string): void {
  const entries = readPaclinks().filter(e => e.virt !== virt);
  entries.push({ virt, deb });
  writePaclinks(entries);
}

export function removePaclink(virt: string): void {
  writePaclinks(readPaclinks().filter(e => e.virt !== virt));
}
