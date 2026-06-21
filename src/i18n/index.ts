import en from './en.json';
import zh from './zh-CN.json';

const _locale = detectLocale();
const _messages: Record<string, string> = (_locale === 'zh-CN' ? { ...en, ...zh } : en);

function detectLocale(): string {
  const lang = process.env.LANG || 'en_US.UTF-8';
  const tag = lang.split('.')[0].replace('_', '-');
  if (tag.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function t(key: string, ...args: (string | number)[]): string {
  let msg = _messages[key];
  if (msg === undefined) msg = key;
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

/* Scoped i18n: each tool loads only its own translation module.
   The scope is the module name under src/i18n/<scope>/<locale>. */
const _scopeCache = new Map<string, Record<string, string>>();

export function scopedT(scope: string): (key: string, ...args: (string | number)[]) => string {
  return (key: string, ...args: (string | number)[]): string => {
    let msgs = _scopeCache.get(scope);
    if (!msgs) {
      let loaded: Record<string, string>;
      try {
        const mod = require(`./${scope}/${_locale}`);
        loaded = mod.default || mod;
      } catch {
        try {
          const mod = require(`./${scope}/en`);
          loaded = mod.default || mod;
        } catch {
          loaded = {};
        }
      }
      _scopeCache.set(scope, loaded);
      msgs = loaded;
    }
    const msg = msgs[key];
    if (msg === undefined) {
      // fall back to main
      const m = _messages[key];
      if (m !== undefined) {
        if (args.length === 0) return m;
        return m.replace(/\{(\d+)\}/g, (_, idx: string) => {
          const i = parseInt(idx, 10);
          return i < args.length ? String(args[i]) : `{${idx}}`;
        });
      }
      return key;
    }
    if (args.length > 0) {
      return msg.replace(/\{(\d+)\}/g, (_, idx: string) => {
        const i = parseInt(idx, 10);
        return i < args.length ? String(args[i]) : `{${idx}}`;
      });
    }
    return msg;
  };
}
