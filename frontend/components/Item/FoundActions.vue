<script setup lang="ts">
  // Fork: "Wiedergefunden" / "Gefunden in …" for an item tagged "Vermisst".
  import MdiCheck from "~icons/mdi/check";
  import MdiFolderMoveOutline from "~icons/mdi/folder-move-outline";
  import { Button } from "@/components/ui/button";
  import type { Movable } from "~/composables/use-move";

  const props = defineProps<{ item: Movable }>();
  const emit = defineEmits<{ done: [] }>();

  const { found, foundIn } = useFound();
  const busy = ref(false);

  async function run(fn: (item: Movable) => Promise<boolean>) {
    busy.value = true;
    try {
      if (await fn(props.item)) emit("done");
    } finally {
      busy.value = false;
    }
  }
</script>

<template>
  <div class="flex gap-2">
    <Button size="sm" :disabled="busy" data-testid="found" @click="run(found)">
      <MdiCheck class="mr-1" />
      {{ $t("box_check.found") }}
    </Button>
    <Button size="sm" variant="outline" :disabled="busy" data-testid="found-in" @click="run(foundIn)">
      <MdiFolderMoveOutline class="mr-1" />
      {{ $t("box_check.found_in") }}
    </Button>
  </div>
</template>
