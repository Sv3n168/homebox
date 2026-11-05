/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompileError, MessageContext } from "vue-i18n";
import { createI18n } from "vue-i18n";
import { IntlMessageFormat } from "intl-messageformat";

// Fork: only English (the fallback) ships in the app bundle; every other
// language is a separate file fetched the first time it is used. All 44
// languages together are 1.7 MB and were part of the start-up download.
import en from "~~/locales/en.json";

const localeModules = import.meta.glob("~//locales/**.json");

/** Language codes we have a file for, e.g. "de", "zh-TW". */
export const availableLocales = Object.keys(localeModules).map(path => path.slice(9, -5));

function matchLocale(wanted: string): string | null {
  const exact = availableLocales.find(l => l.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const base = wanted.split("-")[0]!.toLowerCase();
  return availableLocales.find(l => l.toLowerCase() === base) ?? null;
}

export default defineNuxtPlugin(async ({ vueApp }) => {
  function checkDefaultLanguage() {
    for (const lang of navigator.languages) {
      const found = matchLocale(lang);
      if (found) return found;
    }
    return null;
  }
  const preferences = useViewPreferences();
  const i18n = createI18n({
    fallbackLocale: "en",
    globalInjection: true,
    legacy: false,
    locale: "en",
    messageCompiler,
    messages: { en } as Record<string, any>,
  });
  vueApp.use(i18n);

  const loaded = new Set<string>(["en"]);
  const loading = new Map<string, Promise<void>>();

  async function loadLocale(locale: string): Promise<void> {
    if (loaded.has(locale)) return;
    const importer = localeModules[`/locales/${locale}.json`];
    if (!importer) return;
    let p = loading.get(locale);
    if (!p) {
      p = importer()
        .then(mod => {
          i18n.global.setLocaleMessage(locale, (mod as any).default ?? mod);
          loaded.add(locale);
        })
        .catch(e => console.warn(`[i18n] could not load ${locale}`, e))
        .finally(() => loading.delete(locale));
      loading.set(locale, p);
    }
    await p;
  }

  /** Switches the UI language, fetching its messages first if needed. */
  async function setLocale(locale: string) {
    const found = matchLocale(locale) ?? "en";
    await loadLocale(found);
    i18n.global.locale.value = found;
  }

  // Waited for, so the first screen is not shown in English and then switched
  // (the file is in the service worker's precache, so this works offline too).
  const initial = preferences.value.language || checkDefaultLanguage() || "en";
  await setLocale(initial);

  watch(
    () => preferences.value.language,
    language => {
      if (language) setLocale(language);
    }
  );
  // The language selector writes $i18n.locale directly.
  watch(i18n.global.locale, locale => {
    if (!loaded.has(locale)) setLocale(locale);
  });

  return {
    provide: {
      i18nGlobal: i18n.global,
    },
  };
});

export const messageCompiler: (
  message: string | any,
  {
    locale,
    key,
    onError,
  }: {
    locale: any;
    key: any;
    onError: any;
  }
) => (ctx: MessageContext) => unknown = (message, { locale, key, onError }) => {
  if (typeof message === "string") {
    /**
     * You can tune your message compiler performance more with your cache strategy or also memoization at here
     */
    const formatter = new IntlMessageFormat(message, locale);
    return (ctx: MessageContext) => {
      return formatter.format(ctx.values);
    };
  } else {
    /**
     * for AST.
     * If you would like to support it,
     * You need to transform locale messages such as `json`, `yaml`, etc. with the bundle plugin.
     */
    if (onError) {
      onError(new Error("not support for AST") as CompileError);
    }
    return () => key;
  }
};
