import chalk from 'chalk';

// Colors matching official pacman:
//   sync repos = magenta, local repos = blue, pkg names = green
//   errors = red, warnings = yellow, versions = plain
export const color = {
  repo: chalk.magenta,
  pkg: chalk.green,
  local: chalk.blue,
  error: chalk.bold.red,
  warn: chalk.yellow,
  ok: chalk.green,
  muted: chalk.dim,
  title: chalk.bold,
  size: chalk.magenta,
  rate: chalk.cyan,
};
