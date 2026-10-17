<template>
  <section class="flex flex-col gap-2" data-testid="home-tidy">
    <NuxtLink
      v-if="inboxCount > 0"
      to="/sort"
      class="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm shadow-sm"
      data-testid="inbox-hint"
    >
      <MdiInboxArrowDown class="size-5 shrink-0 text-primary" />
      <span class="grow">{{ $t("sort.hint", { count: inboxCount, name: inbox?.name ?? "" }) }}</span>
      <span class="font-medium text-primary">{{ $t("sort.into_box") }}</span>
    </NuxtLink>
    <NuxtLink
      v-if="missing && missingCount > 0"
      to="/missing"
      class="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm shadow-sm"
      data-testid="missing-hint"
    >
      <MdiHelpCircleOutline class="size-5 shrink-0 text-destructive" />
      <span class="grow">{{ $t("box_check.missing_hint", { count: missingCount }) }}</span>
      <span class="font-medium text-primary">{{ $t("box_check.show") }}</span>
    </NuxtLink>
    <NuxtLink
      v-if="restockCount > 0"
      to="/shopping"
      class="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm shadow-sm"
      data-testid="restock-hint"
    >
      <MdiCartOutline class="size-5 shrink-0 text-amber-600" />
      <span class="grow">{{ $t("restock.hint", { count: restockCount }) }}</span>
      <span class="font-medium text-primary">{{ $t("box_check.show") }}</span>
    </NuxtLink>
    <HomeCheckReminder />
    <!-- One row on the phone, so the shortcuts never take two lines. -->
    <div class="grid grid-cols-3 gap-2 sm:flex">
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="truncate rounded-full border bg-card px-1 py-1.5 text-center text-[13px] sm:px-3 sm:text-sm"
        :data-testid="link.testid"
      >
        {{ $t(link.label) }}
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
  import MdiInboxArrowDown from "~icons/mdi/inbox-arrow-down";
  import MdiHelpCircleOutline from "~icons/mdi/help-circle-outline";
  import MdiCartOutline from "~icons/mdi/cart-outline";
  import { useTagStore } from "~/stores/tags";
  import HomeCheckReminder from "~/components/Home/CheckReminder.vue";

  // Home shortcuts for keeping things in order: unsorted items, missing items,
  // the shopping list,
  // duplicates and untagged items.

  const links = [
    { to: "/duplicates", label: "home.tidy.duplicates", testid: "tidy-duplicates" },
    { to: "/tag-assistant", label: "home.tidy.tags", testid: "tidy-tags" },
    { to: "/sort", label: "home.tidy.sort", testid: "tidy-sort" },
  ];

  const api = useUserApi();
  const { inbox } = useInbox();
  const { tag: missing } = useMissingTag();
  const { tag: restockTag } = useRestock();
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
  const { data: restockData } = useAsyncData(
    "restock-count",
    () => (restockTag.value ? count({ tags: [restockTag.value.id] }) : Promise.resolve(0)),
    {
      watch: [() => restockTag.value?.id],
    }
  );
  const restockCount = computed(() => restockData.value ?? 0);
  const inboxCount = computed(() => inboxData.value ?? 0);
  const missingCount = computed(() => missingData.value ?? 0);
</script>
