import * as zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export function decompress(data: Buffer, filename: string): Buffer {
  if (filename.endsWith('.gz')) return zlib.gunzipSync(data);
  if (filename.endsWith('.xz')) return decompressWith(data, 'xz');
  if (filename.endsWith('.zst')) return decompressWith(data, 'zstd');
  return data;
}

export function decompressAsync(data: Buffer, filename: string): Promise<Buffer> {
  if (filename.endsWith('.gz')) return new Promise((resolve, reject) => {
    zlib.gunzip(data, (err, buf) => err ? reject(err) : resolve(buf));
  });
  if (filename.endsWith('.xz') || filename.endsWith('.zst')) {
    const tool = filename.endsWith('.xz') ? 'xz' : 'zstd';
    return Promise.resolve(decompressWith(data, tool));
  }
  return Promise.resolve(data);
}

export async function decompressStream(stream: NodeJS.ReadableStream, ext: string): Promise<Buffer> {
  if (ext === 'gz') {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.pipe(zlib.createGunzip())
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
  }
  // For xz/zst, collect then decompress
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return decompressAsync(Buffer.concat(chunks), `packages.${ext}`);
}

function decompressWith(data: Buffer, tool: string): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmdeb-'));
  const inFile = path.join(tmp, `input.${tool === 'xz' ? 'xz' : 'zst'}`);
  const outFile = path.join(tmp, 'output');
  try {
    fs.writeFileSync(inFile, data);
    execSync(`${tool} -d -f "${inFile}" --stdout > "${outFile}"`, { stdio: 'pipe' });
    return fs.readFileSync(outFile);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
    try { fs.rmdirSync(tmp); } catch {}
  }
}
