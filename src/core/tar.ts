import * as fs from 'node:fs';
import * as path from 'node:path';

interface TarHeader {
  name: string;
  mode: number;
  size: number;
  type: 'file' | 'directory' | 'symlink' | 'unknown';
  linkname: string;
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const str = buf.subarray(start, start + len).toString('utf8').replace(/\0/g, '').trim();
  return parseInt(str, 8) || 0;
}

function trim(s: string): string {
  return s.replace(/\0/g, '').trim();
}

function readHeader(buf: Buffer): TarHeader | null {
  if (buf.length < 512) return null;
  if (buf.subarray(0, 512).every(b => b === 0)) return null;

  const name = trim(buf.subarray(0, 100).toString('utf8'));
  const prefix = trim(buf.subarray(345, 500).toString('utf8'));
  const mode = parseOctal(buf, 100, 8);
  const size = parseOctal(buf, 124, 12);
  const typeflag = String.fromCharCode(buf[156]);
  const linkname = trim(buf.subarray(157, 257).toString('utf8'));
  const fullName = prefix ? `${prefix}/${name}` : name;

  let type: 'file' | 'directory' | 'symlink' | 'unknown' = 'unknown';
  if (typeflag === '0' || typeflag === '\0') type = 'file';
  else if (typeflag === '5') type = 'directory';
  else if (typeflag === '2') type = 'symlink';

  return { name: fullName, mode, size, type, linkname };
}

export interface TarEntry {
  name: string;
  type: string;
  size: number;
  data: Buffer | null;
  linkname: string;
  mode: number;
}

export function* iterateTar(buf: Buffer): Generator<TarEntry> {
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 512 > buf.length) break;
    const hdr = readHeader(buf.subarray(offset));
    if (!hdr) break;
    offset += 512;
    const paddedSize = Math.ceil(hdr.size / 512) * 512;
    const data = hdr.type === 'file' && hdr.size > 0
      ? buf.subarray(offset, offset + hdr.size) : null;
    yield { name: hdr.name, type: hdr.type, size: hdr.size, data, linkname: hdr.linkname, mode: hdr.mode };
    offset += paddedSize;
  }
}

export function readFileFromTar(buf: Buffer, filePath: string): Buffer | null {
  for (const entry of iterateTar(buf)) {
    if (entry.name === filePath && entry.data) return entry.data;
  }
  return null;
}

export type ProgressCallback = (current: number, total: number, name: string) => void;

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '/' + name) return true;
  if (pattern.endsWith('/*') && (name.startsWith(pattern.slice(0, -1)) || name.startsWith('/' + pattern.slice(0, -1)))) return true;
  if (pattern.includes('*') || pattern.includes('?')) {
    try {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return re.test(name) || re.test('/' + name);
    } catch { return false; }
  }
  return false;
}

export function extractTar(buf: Buffer, dest: string, onProgress?: ProgressCallback, noExtract?: string[], noUpgrade?: string[]): string[] {
  const extracted: string[] = [];
  const entries = [...iterateTar(buf)];
  const total = entries.length;
  for (let i = 0; i < total; i++) {
    const entry = entries[i];
    let targetPath = entry.name;
    if (targetPath.startsWith('./')) targetPath = targetPath.slice(2);
    if (targetPath.startsWith('/')) targetPath = targetPath.slice(1);
    if (!targetPath) continue;
    const fullPath = path.resolve(dest, targetPath);
    if (!fullPath.startsWith(path.resolve(dest))) continue;
    extracted.push(`/${targetPath}`);
    onProgress?.(i + 1, total, targetPath);

    if (noExtract?.some(p => matchGlob(p, targetPath))) continue;

    if (entry.type === 'directory') {
      fs.mkdirSync(fullPath, { recursive: true, mode: entry.mode || 0o755 });
    } else if (entry.type === 'file') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (noUpgrade?.some(p => matchGlob(p, targetPath)) && fs.existsSync(fullPath)) {
        const bak = fullPath + '.pacnew';
        if (entry.data) fs.writeFileSync(bak, entry.data, { mode: entry.mode || 0o644 });
      } else {
        if (entry.data) fs.writeFileSync(fullPath, entry.data, { mode: entry.mode || 0o644 });
      }
    } else if (entry.type === 'symlink') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      try { fs.unlinkSync(fullPath); } catch {}
      fs.symlinkSync(entry.linkname, fullPath);
    }
  }
  return extracted;
}

export function listTarEntries(buf: Buffer): string[] {
  const names: string[] = [];
  for (const entry of iterateTar(buf)) names.push(entry.name);
  return names;
}
