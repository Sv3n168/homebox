<script setup lang="ts">
  import { computed } from "vue";
  import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
  import { Label } from "@/components/ui/label";
  import { dateLocaleCodes, fmtDate } from "~~/composables/use-formatters";
  import { useViewPreferences } from "~~/composables/use-preferences";
  import { availableLocales } from "~~/plugins/i18n";

  const preferences = useViewPreferences();

  // Fork: the list of date-format locales from the file names, not from
  // importing all 96 of them (630 KB). A name the browser can't resolve
  // (RangeError) must not break the page: it shows the code instead.
  const displayName = (inLang: string, code: string) => {
    try {
      return new Intl.DisplayNames([inLang], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  // Fork: languages are loaded on demand, so the list comes from the files
  // we have, and each name in its own language from the browser.
  const ownName = (lang: string) => displayName(lang, lang);
  const uiLanguages = [...availableLocales].sort((a, b) => a.localeCompare(b));

  const locales = dateLocaleCodes.map(code => {
    return {
      code,
      name: displayName(preferences.value.language ?? "en-US", code),
      localName: displayName(code, code),
    };
  });

  defineProps({
    expanded: {
      type: Boolean,
      default: true,
    },
  });

  function setLanguage(lang: string) {
    preferences.value.language = lang;
  }

  function setOverrideLocale(locale: string | undefined) {
    if (locale === undefined || locale === preferences.value.overrideFormatLocale) {
      preferences.value.overrideFormatLocale = undefined;
    } else {
      preferences.value.overrideFormatLocale = locale;
    }
  }

  const dateExample = computed(() => {
    // hack to force vue to update
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const locale = preferences.value.overrideFormatLocale;
    return fmtDate(new Date(Date.now() - 15 * 60000), "relative");
  });
</script>

<template>
  <div class="w-full" :class="{ 'p-5 pt-0': expanded }">
    <Label v-if="expanded" for="language"> {{ $t("profile.language") }} </Label>
    <Select
      id="language"
      v-model="$i18n.locale"
      @update:model-value="
        event => {
          setLanguage(event as string);
        }
      "
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="lang in uiLanguages" :key="lang" :value="lang">
          {{ $t(`languages.${lang}`) }} ({{ ownName(lang) }})
        </SelectItem>
      </SelectContent>
    </Select>
    <template v-if="expanded">
      <Label for="overrideLocale"> {{ $t("profile.override_locale") }} </Label>
      <Select
        id="overrideLocale"
        :model-value="preferences.overrideFormatLocale"
        @update:model-value="
          val => {
            setOverrideLocale(val?.toString());
          }
        "
      >
        <SelectTrigger>
          <SelectValue :placeholder="$t('profile.no_override')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="locale in locales" :key="locale.code" :value="locale.code">
            {{ locale.name }} - ({{ locale.localName }})
          </SelectItem>
        </SelectContent>
      </Select>
      <p class="m-2 text-sm">{{ $t("profile.example") }}: {{ $t("global.created") }} {{ dateExample }}</p>
    </template>
  </div>
</template>
