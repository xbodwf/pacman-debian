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

/* ---- official pacman callback.c column math ---- */

export function getCols(): number {
  return process.stdout.columns || 0;
}

/** Number of decimal digits of n (official util.c number_length). */
export function numberLength(n: number): number {
  let digits = 1;
  while ((n /= 10) >= 1) digits++;
  return digits;
}

/** Split bytes into [value, label] like official humanize_size(bytes, '\0', -1). */
function sizeSplit(bytes: number): [number, string] {
  const labels = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let val = bytes;
  let i = 0;
  while (i < labels.length - 1 && !(val <= 2048 && val >= -2048)) {
    val /= 1024;
    i++;
  }
  return [val, labels[i]];
}

/**
 * Official fill_progress(): ` [####----] 100%` occupying `proglen` terminal
 * columns, ending in a carriage return.
 */
export function fillProgress(percent: number, proglen: number): string {
  const hashlen = proglen > 8 ? proglen - 8 : 0;
  const hash = Math.trunc((percent * hashlen) / 100);
  let s = '';
  if (hashlen > 0) {
    s += ' [';
    for (let i = hashlen; i > 0; i--) s += i > hashlen - hash ? '#' : '-';
    s += ']';
  }
  if (proglen >= 5) s += ` ${percent}%`.padStart(5);
  return s + '\r';
}

/** Trim text to `limit` columns, replacing the tail with `...` (official wide-char truncation). */
function trimToWidth(text: string, limit: number): { display: string; padwid: number } {
  let i = limit - 3;
  let prefix = '';
  for (let j = 0; j < text.length; j++) {
    const w = terminalWidth(text[j]);
    if (i <= w) break;
    i -= w;
    prefix += text[j];
  }
  return { display: prefix + '...', padwid: i };
}

/**
 * Official cb_progress() transaction line:
 * `(%*zu/%*zu) opr [pkgname]... [bar] pct%` filling exactly `cols` columns.
 * When percent==100 the line ends with a newline, else a carriage return.
 */
export function renderTransProgress(text: string, percent: number, howmany: number, current: number): string {
  const cols = getCols();
  if (cols === 0) return '';
  const digits = numberLength(howmany);
  const infolen = Math.max(cols * 6 / 10, 50);
  const textlen = infolen - 3 - (2 * digits) - 1;
  const w = terminalWidth(text);
  let display = text;
  let padwid = textlen - w;
  if (padwid < 0) ({ display, padwid } = trimToWidth(text, textlen));
  let line = `(${String(current).padStart(digits)}/${String(howmany).padStart(digits)}) ${display}`;
  if (padwid > 0) line += ' '.repeat(padwid);
  line += fillProgress(percent, cols - infolen);
  return percent === 100 ? line + '\n' : line;
}

export interface DownloadBarOpts {
  filename: string;
  total: number;
  xfered: number;
  rate: number;
  eta: number;
  howmany?: number;
  downloaded?: number;
}

/** Strip .pkg/.db/.files extension (official clean_filename). */
export function cleanFilename(filename: string): string {
  for (const needle of ['.pkg', '.db', '.files']) {
    const p = filename.indexOf(needle);
    if (p >= 0) return filename.slice(0, p);
  }
  return filename;
}

/**
 * Official draw_pacman_progress_bar(): download row that fills exactly `cols`
 * columns. Trailing CR from fill_progress (caller adds newline when finished).
 */
export function renderDownloadBar(o: DownloadBarOpts): string {
  const cols = getCols();
  if (cols === 0) return '';
  const infolen = Math.max(cols * 6 / 10, 50);
  const filenamelen = infolen - 30;

  let fname = cleanFilename(o.filename);
  if ((o.howmany ?? 0) > 0) {
    const digits = numberLength(o.howmany!);
    fname = `${fname} (${String(o.downloaded ?? 0).padStart(digits)}/${String(o.howmany).padStart(digits)})`;
  }
  const w = terminalWidth(fname);
  let display = fname;
  let padwid = filenamelen - w;
  if (padwid < 0) ({ display, padwid } = trimToWidth(fname, filenamelen));

  const filePercent = o.total ? Math.trunc((o.xfered * 100) / o.total) : 100;
  const [xv, xl] = sizeSplit(o.xfered);
  const [rv, rl] = sizeSplit(o.rate);

  let s = ` ${display}`;
  if (padwid > 0) s += ' '.repeat(padwid);
  s += ` `;
  s += `${xv.toFixed(1).padStart(6)} ${xl.padStart(3)}  `;
  if (rv < 9.995) s += `${rv.toFixed(2).padStart(4)} ${rl.padStart(3)}/s `;
  else if (rv < 99.95) s += `${rv.toFixed(1).padStart(4)} ${rl.padStart(3)}/s `;
  else s += `${String(Math.round(rv)).padStart(4)} ${rl.padStart(3)}/s `;

  const eta = Math.max(Math.floor(o.eta), 0);
  const h = Math.floor(eta / 3600);
  const m = Math.floor((eta - h * 3600) / 60);
  const sec = Math.floor(eta - h * 3600 - m * 60);
  if (h === 0) s += `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  else if (h === 1 && m < 40) s += `${String(m + 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  else s += '--:--';

  return s + fillProgress(filePercent, cols - infolen);
}
