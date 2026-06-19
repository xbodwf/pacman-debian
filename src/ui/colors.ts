// ANSI escape codes matching official pacman colors.
// sync repos = magenta, local repos = blue, pkg names = green
// errors = red, warnings = yellow

const esc = (n: number) => `\x1b[${n}m`;

const c = {
  magenta: esc(35),
  green: esc(32),
  blue: esc(34),
  red: esc(31),
  yellow: esc(33),
  cyan: esc(36),
  dim: esc(2),
  bold: esc(1),
  reset: esc(0),
};

export const color = {
  repo: (s: string) => `${c.magenta}${s}${c.reset}`,
  pkg: (s: string) => `${c.green}${s}${c.reset}`,
  local: (s: string) => `${c.blue}${s}${c.reset}`,
  error: (s: string) => `${c.bold}${c.red}${s}${c.reset}`,
  warn: (s: string) => `${c.yellow}${s}${c.reset}`,
  ok: (s: string) => `${c.green}${s}${c.reset}`,
  muted: (s: string) => `${c.dim}${s}${c.reset}`,
  title: (s: string) => `${c.bold}${s}${c.reset}`,
  size: (s: string) => `${c.magenta}${s}${c.reset}`,
  rate: (s: string) => `${c.cyan}${s}${c.reset}`,
};
