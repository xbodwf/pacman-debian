#!/usr/bin/env node
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

function main() {
  // Try reading the alternatives link
  try {
    const link = fs.readlinkSync('/etc/alternatives/java');
    const match = link.match(/\/usr\/lib\/jvm\/([^/]+)/);
    if (match) {
      console.log(match[1]);
      return;
    }
  } catch {}

  // Fallback: scan /usr/lib/jvm for valid JDKs
  const jvmDir = '/usr/lib/jvm';
  if (fs.existsSync(jvmDir)) {
    for (const dir of fs.readdirSync(jvmDir).sort()) {
      const javaBin = `${jvmDir}/${dir}/bin/java`;
      if (fs.existsSync(javaBin)) {
        console.log(dir);
        return;
      }
    }
  }

  // Try resolving java -version to find the JVM
  try {
    const out = execSync('java -XshowSettings:vm 2>&1 | grep "java.home" | head -1', { encoding: 'utf8' });
    const match = out.match(/java\.home\s*=\s*\/(.+)/);
    if (match) {
      const path = match[1].trim().replace(/^home\//, '');
      const nameMatch = match[1].match(/jvm\/([^/]+)/);
      if (nameMatch) {
        console.log(nameMatch[1]);
        return;
      }
    }
  } catch {}

  process.exit(1);
}

main();
