import { format, formatDistance } from "date-fns";
import type { Locale } from "date-fns";
import { reactive } from "vue";
import { isDateOnlyString, parseDateOnly } from "~/lib/datelib/dateOnly";
import { fmtCurrency, fmtCurrencyAsync } from "./utils";

const cache = reactive({
  currency: "",
});
// Fork: every <Currency> on a page asked the server for the group at once.
let groupRequest: Promise<void> | null = null;

export function resetCurrency() {
  cache.currency = "";
}

export function setCurrency(currency: string) {
  cache.currency = currency;
}

export async function useFormatCurrency() {
  if (cache.currency === "") {
    groupRequest ??= useUserApi()
      .group.get()
      .then(({ data: group }) => {
        if (group && cache.currency === "") cache.currency = group.currency;
      })
      .finally(() => {
        groupRequest = null;
      });
    await groupRequest;
  }

  // Pre-load currency decimals for better formatting (optional, non-blocking)
  if (cache.currency && cache.currency.trim() !== "") {
    try {
      await fmtCurrencyAsync(0, cache.currency, getLocaleCode());
    } catch (error) {
      // Silently swallow preload errors - formatter will still work, just without pre-cached decimals
      console.debug("Currency preload failed (non-fatal):", error);
    }
  }

  return (value: number | string) => fmtCurrency(value, cache.currency, getLocaleCode());
}

export type DateTimeFormat = "relative" | "long" | "short" | "human";
export type DateTimeType = "date" | "time" | "datetime";

export function getLocaleCode() {
  const { $i18nGlobal } = useNuxtApp();
  const preferences = useViewPreferences();
  // TODO: make reactive
  if (preferences.value.overrideFormatLocale) {
    return preferences.value.overrideFormatLocale;
  }
  return ($i18nGlobal?.locale?.value as string) ?? "en-US";
}

// Fork: date-fns ships 96 locales (630 KB); only the one in use is loaded,
// on demand. Until it has arrived dates render in English, then re-render
// (the cache is reactive).
// cdn*.js bundle all locales in one file (1.2 MB) and types.js is empty: not locales.
const dateLocales = import.meta.glob<{ default: Locale }>([
  "/node_modules/date-fns/locale/*.js",
  "!/node_modules/date-fns/locale/cdn*.js",
  "!/node_modules/date-fns/locale/types.js",
]);

/** The date-format locales there are, e.g. "de", "en-GB". */
export const dateLocaleCodes = Object.keys(dateLocales).map(p => p.slice(p.lastIndexOf("/") + 1, -3));
const loadedLocales = reactive<Record<string, Locale>>({});
const loadingLocales = new Set<string>();

function loadDateLocale(key: string) {
  const importer = dateLocales[`/node_modules/date-fns/locale/${key}.js`];
  if (!importer || loadingLocales.has(key)) return false;
  loadingLocales.add(key);
  importer()
    .then(mod => {
      loadedLocales[key] = mod.default;
    })
    .catch(() => {})
    .finally(() => loadingLocales.delete(key));
  return true;
}

function getLocaleForDate(): Locale | undefined {
  const localeCode = getLocaleCode();
  const lang = localeCode.length > 1 ? localeCode.substring(0, 2) : localeCode;
  const region = localeCode.length > 2 ? localeCode.substring(3) : "";
  for (const key of region ? [`${lang}-${region}`, lang] : [lang]) {
    if (loadedLocales[key]) return loadedLocales[key];
    if (loadDateLocale(key)) return undefined;
  }
  return undefined;
}

export function fmtDate(
  value: string | Date | number,
  fmt: DateTimeFormat = "human",
  type: DateTimeType = "date"
): string {
  // YYYY-MM-DD must be parsed via local components — `new Date("2026-04-17")`
  // is UTC midnight, which renders as the previous day in any timezone west
  // of UTC.
  let dt: Date | null;
  if (isDateOnlyString(value)) {
    dt = parseDateOnly(value);
  } else if (typeof value === "string" || typeof value === "number") {
    dt = new Date(value);
  } else {
    dt = value;
  }

  if (!dt || !validDate(dt)) {
    return "";
  }

  const localeOptions = { locale: getLocaleForDate() };

  if (fmt === "relative") {
    return `${formatDistance(dt, new Date(), { ...localeOptions, addSuffix: true })} (${fmtDate(dt, "short", "date")})`;
  }

  if (type === "time") {
    return format(dt, "p", localeOptions);
  }

  let formatStr: string;

  switch (fmt) {
    case "human":
      formatStr = "PPP";
      break;
    case "long":
      formatStr = "PP";
      break;
    case "short":
      formatStr = "P";
      break;
    default:
      return "";
  }
  if (type === "datetime") {
    formatStr += "p";
  }

  return format(dt, formatStr, localeOptions);
}
