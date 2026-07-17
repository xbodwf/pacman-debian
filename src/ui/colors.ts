// ANSI escape codes matching official pacman colors.
// sync repos = magenta, local repos = blue, pkg names = green
// errors = red, warnings = yellow
// Controlled by `Color` in pacman.conf [options].

import { loadConfig } from '../repo/config';

const esc = (n: number) => `\x1b[${n}m`;

const ansi = {
  magenta: esc(35), green: esc(32), blue: esc(34), red: esc(31),
  yellow: esc(33), cyan: esc(36), dim: esc(2), bold: esc(1), reset: esc(0),
};

let configEnabled = false;
let override: 'always' | 'never' | 'auto' | undefined;

function checkConfig() {
  try {
    const cfg = loadConfig();
    configEnabled = cfg.color;
  } catch {}
}
checkConfig();

export function setColorMode(mode: 'always' | 'never' | 'auto'): void {
  override = mode;
}

function enabled(): boolean {
  if (override === 'always') return true;
  if (override === 'never') return false;
  return configEnabled && !!process.stdout.isTTY;
}

function c(code: string): (s: string) => string {
  return (s: string) => (enabled() ? `${code}${s}${ansi.reset}` : s);
}

export const color = {
  repo: c(ansi.magenta),
  pkg: c(ansi.green),
  local: c(ansi.blue),
  error: c(ansi.bold + ansi.red),
  warn: c(ansi.yellow),
  ok: c(ansi.green),
  muted: c(ansi.dim),
  title: c(ansi.bold),
  size: c(ansi.magenta),
  rate: c(ansi.cyan),
};
