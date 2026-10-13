<template>
  <section v-if="boxes.length > 0" data-testid="my-boxes">
    <Subtitle>{{ $t("places.my_boxes") }}</Subtitle>
    <div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      <NuxtLink
        v-for="box in boxes"
        :key="box.id"
        :to="`/location/${box.id}`"
        class="flex shrink-0 items-center gap-2 rounded-full border bg-card px-4 py-2 shadow-sm"
      >
        <MdiStar v-if="places.isPinned(box.id)" class="size-4 text-amber-500" />
        <MdiHistory v-else class="size-4 text-muted-foreground" />
        <span class="max-w-48 truncate text-sm font-medium">{{ box.name }}</span>
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
  import MdiStar from "~icons/mdi/star";
  import MdiHistory from "~icons/mdi/history";
  import Subtitle from "~/components/global/Subtitle.vue";

  const places = usePlaces();
  const tree = useFlatLocations();
  const boxes = computed(() =>
    places.favorites.value.map(id => tree.value.find(l => l.id === id)).filter((b): b is FlatTreeItem => !!b)
  );
</script>
