<template>
  <NuxtLink
    v-if="count > 0"
    to="/tag-assistant"
    class="flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm"
    data-testid="untagged-hint"
  >
    <MdiTagOffOutline class="size-6 shrink-0 text-amber-600" />
    <span class="grow">{{ $t("tag_assistant.hint", { count }) }}</span>
    <span class="font-medium text-primary">{{ $t("tag_assistant.start") }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
  import MdiTagOffOutline from "~icons/mdi/tag-off-outline";

  const api = useUserApi();
  const { data } = useAsyncData("untagged-count", async () => {
    const { data, error } = await api.items.getAll({ onlyWithoutTags: true, page: 1, pageSize: 1 });
    return error ? 0 : data.total;
  });
  const count = computed(() => data.value ?? 0);
</script>
