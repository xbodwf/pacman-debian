#!/usr/bin/env node
import { parseArgs } from './cli/pacman';

parseArgs(process.argv.slice(2)).then(() => process.exit(0)).catch(e => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
