#!/usr/bin/env node
import { parseArgs } from './cli/pacman';
import { t } from './i18n';

const args = process.argv.slice(2);

if (process.getuid && process.getuid() !== 0) {
  const ok = ['-Q', '--query', '-Ss', '-Si', '-h', '--help', '-Qs']
    .some(p => args[0] === p || args[0]?.startsWith(p));
  if (!ok) {
    const qFlags = ['-i', '-o', '-l', '-s', '--info', '--owns', '--list', '--search'];
    if (!(args[0]?.startsWith('-Q') && qFlags.includes(args[1]))) {
      console.error(t('error_need_root'));
      process.exit(1);
    }
  }
}

parseArgs(args).catch(e => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
