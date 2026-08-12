export function formatBytes(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1048576) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  return `${sign}${(abs / 1048576).toFixed(2)} MiB`;
}

/** Split bytes into [value, unit] like official pacman humanize_size (precision 2). */
export function humanizeSize(bytes: number): [string, string] {
  if (bytes >= 1024 ** 4) return [(bytes / 1024 ** 4).toFixed(2), 'TiB'];
  if (bytes >= 1024 ** 3) return [(bytes / 1024 ** 3).toFixed(2), 'GiB'];
  if (bytes >= 1024 ** 2) return [(bytes / 1024 ** 2).toFixed(2), 'MiB'];
  if (bytes >= 1024) return [(bytes / 1024).toFixed(2), 'KiB'];
  return [bytes.toFixed(2), 'B'];
}

export function pkgLabel(name: string, version: string): string {
  return `${name}-${version}`;
}
