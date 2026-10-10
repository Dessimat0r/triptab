import { SPANISH_UI } from './ui-spanish';
import { FRENCH_UI } from './ui-french';
import { GERMAN_UI } from './ui-german';
export const UI_LANGUAGES = ['en', 'es', 'fr', 'de'] as const;
export const isUiLanguage = (value: unknown): value is UiLanguage =>
  typeof value === 'string' &&
  (UI_LANGUAGES as readonly string[]).includes(value);
export type UiLanguage = (typeof UI_LANGUAGES)[number];
let language: UiLanguage = 'en';
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
      if (isUiLanguage(saved)) language = saved;
    } catch {}
  }
  listener(language);
  return () => {
    listeners.delete(listener);
  };
}
/** Only explicit interface copy goes through this function; names and receipt text do not. */
export function t(text: string): string {
  if (language === 'en') return text;
  const core = text.trim(),
    translated = (
      language === 'es' ? SPANISH_UI : language === 'fr' ? FRENCH_UI : GERMAN_UI
    )[core];
  return translated ? text.replace(core, translated) : text;
}
