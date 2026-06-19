import en from './en.json';
import zh from './zh-CN.json';

const locales: Record<string, Record<string, string>> = { en, 'zh-CN': zh };

function detectLocale(): string {
  const lang = process.env.LANG || 'en_US.UTF-8';
  const tag = lang.split('.')[0].replace('_', '-');
  if (tag.startsWith('zh')) return 'zh-CN';
  return 'en';
}

const _locale = detectLocale();
const _messages = locales[_locale] || locales.en;

export function t(key: string, ...args: (string | number)[]): string {
  let msg = _messages[key];
  if (msg === undefined) {
    msg = locales.en[key] ?? key;
  }
  if (args.length > 0) {
    msg = msg.replace(/\{(\d+)\}/g, (_, idx: string) => {
      const i = parseInt(idx, 10);
      return i < args.length ? String(args[i]) : `{${idx}}`;
    });
  }
  return msg;
}

export function getLocale(): string {
  return _locale;
}
