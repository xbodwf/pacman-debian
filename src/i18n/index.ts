import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCALE_DIR = __dirname;

let _messages: Record<string, string> | null = null;
let _locale = '';

function detectLocale(): string {
  const lang = process.env.LANG || 'en_US.UTF-8';
  const tag = lang.split('.')[0].replace('_', '-');
  if (tag.startsWith('zh')) return 'zh-CN';
  return 'en';
}

function loadMessages(locale: string): Record<string, string> {
  const filePath = path.join(LOCALE_DIR, `${locale}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return {};
}

export function t(key: string, ...args: (string | number)[]): string {
  if (!_messages) {
    _locale = detectLocale();
    _messages = loadMessages(_locale);
  }
  let msg = _messages[key];
  if (msg === undefined) {
    // fallback to English
    const en = loadMessages('en');
    msg = en[key] ?? key;
  }
  // Replace {0}, {1}, etc.
  if (args.length > 0) {
    msg = msg.replace(/\{(\d+)\}/g, (_, idx: string) => {
      const i = parseInt(idx, 10);
      return i < args.length ? String(args[i]) : `{${idx}}`;
    });
  }
  return msg;
}

export function getLocale(): string {
  if (!_messages) {
    _locale = detectLocale();
    _messages = loadMessages(_locale);
  }
  return _locale;
}
