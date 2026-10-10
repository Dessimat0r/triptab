import { SPANISH_UI } from './ui-spanish';
import { FRENCH_UI } from './ui-french';
import { GERMAN_UI } from './ui-german';
import copy from './ui-copy.json' with { type: 'json' };
export const UI_LANGUAGES = ['en', 'es', 'fr', 'de'] as const;
export const isUiLanguage = (value: unknown): value is UiLanguage =>
  typeof value === 'string' &&
  (UI_LANGUAGES as readonly string[]).includes(value);
export type UiLanguage = (typeof UI_LANGUAGES)[number];
let language: UiLanguage = 'en';
const catalogs: Record<Exclude<UiLanguage, 'en'>, Readonly<Record<string, string>>> = {
  es: { ...SPANISH_UI, ...Object.fromEntries(copy.map(row => [row[0], row[1]])) },
  fr: { ...FRENCH_UI, ...Object.fromEntries(copy.map(row => [row[0], row[2]])) },
  de: { ...GERMAN_UI, ...Object.fromEntries(copy.map(row => [row[0], row[3]])) },
};
export function getUiLanguage(): UiLanguage { return language; }
export function getUiLocale(): string { return language === 'en' ? 'en-GB' : language; }
const currencyNames = new Map<string, Intl.DisplayNames>();
export function currencyDisplayName(code: string, original: string): string {
  if (language === 'en') return original;
  let formatter = currencyNames.get(language);
  if (!formatter) currencyNames.set(language, formatter = new Intl.DisplayNames(language, { type: 'currency' }));
  const name = formatter.of(code) || original;
  return original.includes('(legacy receipts)') ? `${name} (${t('legacy receipts')})` : name;
}
export function getUiCatalog(value: UiLanguage): Readonly<Record<string, string>> {
  return value === 'en' ? {} : catalogs[value];
}
// API messages and older UI helpers still build English sentences. Match only
// the explicit, reviewed interface templates, then interpolate their data once.
// Receipt names, notes, and chat replies never go through this path.
const messageTemplates = Object.keys(catalogs.es).filter(key => /\{\w+\}/.test(key)).map(key => {
  const slots: string[] = [];
  let cursor = 0, expression = '^';
  const escape = (text: string) => text.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  for (const match of key.matchAll(/\{(\w+)\}/g)) {
    expression += escape(key.slice(cursor, match.index)) + '([\\s\\S]*?)';
    slots.push(match[1]);
    cursor = match.index! + match[0].length;
  }
  expression += escape(key.slice(cursor)) + '$';
  return { key, slots, prefix: key.slice(0, key.indexOf('{')), pattern: new RegExp(expression, 'u') };
});
export type UiValues = Readonly<Record<string, string | number | null | undefined>>;
function interpolate(text: string, values: UiValues): string {
  return text.replace(/\{([\w]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}
/** Translate interface templates without translating or interpreting their values. */
export function translateUi(text: string, value: UiLanguage, values: UiValues = {}): string {
  const core = text.trim();
  const catalog = getUiCatalog(value);
  let key = core, parameters = values;
  if (value !== 'en' && !Object.hasOwn(catalog, core) && !Object.keys(values).length && core.length <= 4000) {
    for (const template of messageTemplates) {
      if (!core.startsWith(template.prefix)) continue;
      const match = template.pattern.exec(core);
      if (!match) continue;
      key = template.key;
      parameters = Object.fromEntries(template.slots.map((slot, index) => [slot, match[index + 1]]));
      break;
    }
  }
  const translated = Object.hasOwn(catalog, key) ? catalog[key] : core;
  return interpolate(core ? text.replace(core, () => translated) : text, parameters);
}
const listeners = new Set<(language: UiLanguage) => void>();
export function setUiLanguage(next: UiLanguage) {
  language = next;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('triptab.ui-language', next);
    } catch {}
    document.documentElement.lang = next;
  }
  for (const listener of listeners) listener(next);
}
export function subscribeUiLanguage(listener: (language: UiLanguage) => void) {
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('triptab.ui-language');
      if (isUiLanguage(saved)) {
        language = saved;
        document.documentElement.lang = saved;
      }
    } catch {}
  }
  listener(language);
  return () => {
    listeners.delete(listener);
  };
}
/** Only explicit interface copy goes through this function; names and receipt text do not. */
export function t(text: string, values: UiValues = {}): string {
  return translateUi(text, language, values);
}
