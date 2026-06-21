#!/usr/bin/env node
import { execSync } from 'node:child_process';

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');

  try {
    if (process.getuid && process.getuid() !== 0) {
      console.error('error: must be root');
      process.exit(1);
    }

    const caDir = '/etc/ssl/certs/java';
    if (!require('fs').existsSync(caDir)) {
      require('fs').mkdirSync(caDir, { recursive: true });
    }

    // Debian: update-ca-certificates
    try {
      execSync('update-ca-certificates' + (force ? ' -f' : ''), { stdio: 'pipe' });
    } catch {
      // Fallback: manually link ca-certificates.crt
      const src = '/etc/ssl/certs/ca-certificates.crt';
      const dst = '/etc/ssl/certs/java/cacerts';
      if (require('fs').existsSync(src) && !require('fs').existsSync(dst)) {
        require('fs').copyFileSync(src, dst);
      }
    }
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

main();
