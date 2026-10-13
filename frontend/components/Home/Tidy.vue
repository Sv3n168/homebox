<template>
  <section class="flex flex-col gap-2" data-testid="home-tidy">
    <NuxtLink
      v-if="inboxCount > 0"
      to="/sort"
      class="flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm"
      data-testid="inbox-hint"
    >
      <MdiInboxArrowDown class="size-6 shrink-0 text-primary" />
      <span class="grow">{{ $t("sort.hint", { count: inboxCount, name: inbox?.name ?? "" }) }}</span>
      <span class="font-medium text-primary">{{ $t("sort.into_box") }}</span>
    </NuxtLink>
    <NuxtLink
      v-if="missing && missingCount > 0"
      :to="`/tag/${missing.id}`"
      class="flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm"
      data-testid="missing-hint"
    >
      <MdiHelpCircleOutline class="size-6 shrink-0 text-destructive" />
      <span class="grow">{{ $t("box_check.missing_hint", { count: missingCount }) }}</span>
      <span class="font-medium text-primary">{{ $t("box_check.show") }}</span>
    </NuxtLink>
    <div class="flex flex-wrap gap-2 text-sm">
      <NuxtLink to="/duplicates" class="rounded-full border bg-card px-3 py-1.5" data-testid="tidy-duplicates">
        {{ $t("duplicates.title") }}
      </NuxtLink>
      <NuxtLink to="/tag-assistant" class="rounded-full border bg-card px-3 py-1.5">
        {{ $t("tag_assistant.title") }}
      </NuxtLink>
      <NuxtLink to="/sort" class="rounded-full border bg-card px-3 py-1.5" data-testid="tidy-sort">
        {{ $t("sort.title") }}
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
  import MdiInboxArrowDown from "~icons/mdi/inbox-arrow-down";
  import MdiHelpCircleOutline from "~icons/mdi/help-circle-outline";
  import { useTagStore } from "~/stores/tags";

  // Home shortcuts for keeping things in order: unsorted items, missing items,
  // duplicates and untagged items.

  const api = useUserApi();
  const { inbox } = useInbox();
  const { tag: missing } = useMissingTag();
  useTagStore().ensureAllTagsFetched();

  async function count(q: Parameters<typeof api.items.getAll>[0]) {
    const { data, error } = await api.items.getAll({ ...q, page: 1, pageSize: 1 });
    return error ? 0 : data.total;
  }

  const { data: inboxData } = useAsyncData(
    "inbox-count",
    () => (inbox.value ? count({ parentIds: [inbox.value.id] }) : Promise.resolve(0)),
    {
      watch: [() => inbox.value?.id],
    }
  );
  const { data: missingData } = useAsyncData(
    "missing-count",
    () => (missing.value ? count({ tags: [missing.value.id] }) : Promise.resolve(0)),
    {
      watch: [() => missing.value?.id],
    }
  );
  const inboxCount = computed(() => inboxData.value ?? 0);
  const missingCount = computed(() => missingData.value ?? 0);
</script>
