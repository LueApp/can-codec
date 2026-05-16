// Lightweight i18n store for EN / ZH.
//
// Usage:
//   import { i18n, t } from '$lib/i18n.svelte';
//   <h1>{t('nav.messages')}</h1>
//   <button onclick={() => i18n.setLocale('zh')}>中文</button>
//
// `t(key)` reads `i18n.locale` reactively, so any template that calls it
// re-evaluates when the locale changes.

import { translations, type Locale, type TranslationKey } from './translations';

const STORAGE_KEY = 'can-codec-locale';

function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const langs = (navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
  for (const lang of langs) {
    if (!lang) continue;
    if (lang.toLowerCase().startsWith('zh')) return 'zh';
    if (lang.toLowerCase().startsWith('en')) return 'en';
  }
  return 'en';
}

function loadInitialLocale(): Locale {
  if (typeof localStorage === 'undefined') return 'en';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') return saved;
  return detectBrowserLocale();
}

class I18nStore {
  locale = $state<Locale>('en');

  constructor() {
    if (typeof window !== 'undefined') {
      this.locale = loadInitialLocale();
      this.applyHtmlLang();
    }
  }

  setLocale(loc: Locale) {
    this.locale = loc;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, loc);
    }
    this.applyHtmlLang();
  }

  toggle() {
    this.setLocale(this.locale === 'en' ? 'zh' : 'en');
  }

  private applyHtmlLang() {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = this.locale === 'zh' ? 'zh-CN' : 'en';
    }
  }
}

export const i18n = new I18nStore();

export function t(key: TranslationKey): string {
  const bundle = translations[i18n.locale];
  const val = bundle[key];
  if (val !== undefined) return val;
  // Fall back to English if a Chinese key is missing.
  return translations.en[key] ?? key;
}

export type { Locale, TranslationKey } from './translations';
