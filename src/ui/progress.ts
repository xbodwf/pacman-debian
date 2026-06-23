export function humanSize(n: number, dec: number): { val: string; unit: string } {
  const abs = Math.abs(n);
  let v: number, u: string;
  if (abs < 1024) { v = n; u = 'B'; }
  else if (abs < 1048576) { v = n / 1024; u = 'KiB'; }
  else if (abs < 1073741824) { v = n / 1048576; u = 'MiB'; }
  else { v = n / 1073741824; u = 'GiB'; }
  return { val: v.toFixed(dec), unit: u };
}

/** Calculate terminal display width (Chinese chars count as 2) */
export function terminalWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs and related blocks
    if ((cp >= 0x2E80 && cp <= 0x9FFF) ||   // CJK Radicals + CJK Unified Ideographs
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
        (cp >= 0xFF00 && cp <= 0xFFEF) ||   // Fullwidth forms
        (cp >= 0x3000 && cp <= 0x303F))     // CJK Symbols and Punctuation
      w += 2;
    else w += 1;
  }
  return w;
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
