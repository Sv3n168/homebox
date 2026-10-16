<script setup lang="ts">
  // Fork: everything a box check flagged as missing (tag "Vermisst"), with
  // "found" / "found in …" right in the list.
  import { useI18n } from "vue-i18n";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiHelpCircleOutline from "~icons/mdi/help-circle-outline";
  import { Card } from "@/components/ui/card";
  import BaseContainer from "@/components/Base/Container.vue";
  import ItemFoundActions from "~/components/Item/FoundActions.vue";
  import { useTagStore } from "~/stores/tags";

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("box_check.missing_title") });

  const api = useUserApi();
  const missingTag = useMissingTag();
  const tagStore = useTagStore();

  const { data, refresh, pending } = useAsyncData("missing-page", async () => {
    await tagStore.ensureAllTagsFetched();
    const id = missingTag.tag.value?.id;
    if (!id) return [] as EntitySummary[];
    const { data, error } = await api.items.getAll({ tags: [id], page: -1, pageSize: -1, orderBy: "name" });
    if (error) return [] as EntitySummary[];
    return data.items;
  });

  const items = computed(() => data.value ?? []);

  function done() {
    refresh();
    refreshNuxtData("missing-count");
  }
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header>
      <h1 class="text-2xl font-semibold">{{ $t("box_check.missing_title") }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("box_check.missing_intro") }}</p>
    </header>

    <p v-if="pending && !data" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card
      v-else-if="items.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="missing-none"
    >
      <MdiCheckCircle class="size-12 text-primary" />
      <p class="text-lg font-medium">{{ $t("box_check.missing_none") }}</p>
    </Card>

    <Card v-else class="divide-y overflow-hidden">
      <div
        v-for="e in items"
        :key="e.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:flex-nowrap"
        data-testid="missing-row"
      >
        <div class="flex min-w-0 basis-full items-start gap-3 sm:grow sm:basis-auto">
          <MdiHelpCircleOutline class="mt-0.5 size-5 shrink-0 text-destructive" />
          <div class="min-w-0 grow">
            <NuxtLink :to="`/item/${e.id}`" class="font-medium hover:underline">{{ e.name }}</NuxtLink>
            <div v-if="e.parent" class="text-sm text-muted-foreground">
              {{ $t("box_check.last_seen") }}
              <NuxtLink :to="`/location/${e.parent.id}`" class="hover:underline">{{ e.parent.name }}</NuxtLink>
            </div>
          </div>
        </div>
        <ItemFoundActions :item="e" class="w-full sm:w-auto" @done="done" />
      </div>
    </Card>
  </BaseContainer>
</template>
