export function humanSize(n: number, dec: number): { val: string; unit: string } {
  const abs = Math.abs(n);
  let v: number, u: string;
  if (abs < 1024) { v = n; u = 'B'; }
  else if (abs < 1048576) { v = n / 1024; u = 'KiB'; }
  else if (abs < 1073741824) { v = n / 1048576; u = 'MiB'; }
  else { v = n / 1073741824; u = 'GiB'; }
  return { val: v.toFixed(dec), unit: u };
}

export function drawProgressBar(pct: number, width: number): string {
  const barLen = Math.max(width, 5);
  const hashes = Math.round(pct / 100 * barLen);
  return '#'.repeat(hashes) + '-'.repeat(Math.max(barLen - hashes, 0));
}

export function formatRate(rate: number): string {
  if (rate < 9.995) { const s = humanSize(rate, 2); return `${s.val.padStart(4)} ${s.unit}/s`.padStart(12); }
  if (rate < 99.95) { const s = humanSize(rate, 1); return `${s.val.padStart(4)} ${s.unit}/s`.padStart(12); }
  const s = humanSize(rate, 0); return `${s.val.padStart(4)} ${s.unit}/s`.padStart(12);
}

export function formatETA(eta: number): string {
  if (eta <= 0 || eta >= 7200) return '--:--';
  return `${String(Math.floor(eta / 60)).padStart(2, '0')}:${String(Math.floor(eta % 60)).padStart(2, '0')}`;
}
