export function formatBytes(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1048576) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  return `${sign}${(abs / 1048576).toFixed(2)} MiB`;
}

export function pkgLabel(name: string, version: string): string {
  return `${name}-${version}`;
}
