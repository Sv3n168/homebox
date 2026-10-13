<template>
  <!-- "Put things into this box": search any item and move it here with one tap. -->
  <DialogRoot v-model:open="open">
    <DialogContent class="flex max-h-[85dvh] flex-col gap-3">
      <DialogHeader data-testid="collect-dialog">
        <DialogTitle>{{ $t("collect.title", { box: box.name }) }}</DialogTitle>
      </DialogHeader>
      <Input v-model="query" type="search" :placeholder="$t('collect.search')" data-testid="collect-search" />
      <div class="-mx-2 min-h-0 flex-1 overflow-y-auto">
        <p v-if="!query" class="px-2 py-4 text-center text-sm text-muted-foreground">{{ $t("collect.hint") }}</p>
        <div
          v-for="item in results"
          :key="item.id"
          class="flex items-center gap-3 rounded-xl p-2"
          data-testid="collect-row"
        >
          <div class="min-w-0 grow">
            <div class="truncate font-medium">{{ item.name }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ pathOf(item) }}</div>
          </div>
          <span v-if="movedIds.includes(item.id)" class="flex items-center gap-1 text-sm text-primary">
            <MdiCheck class="size-4" /> {{ $t("collect.done") }}
          </span>
          <Button v-else size="sm" @click="collect(item)">
            <MdiArrowDownBold class="size-4" />
            {{ $t("collect.here") }}
          </Button>
        </div>
        <p v-if="query && !loading && results.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">
          {{ $t("items.no_results") }}
        </p>
      </div>
    </DialogContent>
  </DialogRoot>
</template>

<script setup lang="ts">
  import { DialogRoot } from "reka-ui";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheck from "~icons/mdi/check";
  import MdiArrowDownBold from "~icons/mdi/arrow-down-bold";
  import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";

  const props = defineProps<{ box: { id: string; name: string } }>();
  const emit = defineEmits<{ moved: [] }>();
  const open = defineModel<boolean>("open", { default: false });

  const api = useUserApi();
  const { move } = useMove();
  const tree = useFlatLocations();

  const query = ref("");
  const results = ref<EntitySummary[]>([]);
  const loading = ref(false);
  const movedIds = ref<string[]>([]);

  watch(open, isOpen => {
    if (isOpen) {
      query.value = "";
      results.value = [];
      movedIds.value = [];
    }
  });

  watchDebounced(
    query,
    async q => {
      if (!q.trim()) {
        results.value = [];
        return;
      }
      loading.value = true;
      const { data, error } = await api.items.getAll({ q, page: 1, pageSize: 30, orderBy: "name" });
      loading.value = false;
      // Already in this box: nothing to do.
      results.value = error
        ? []
        : data.items.filter(i => i.parent?.id !== props.box.id || movedIds.value.includes(i.id));
    },
    { debounce: 200 }
  );

  function pathOf(item: EntitySummary) {
    const id = item.parent?.id;
    const full = (id && tree.value.find(l => l.id === id)?.treeString) || item.parent?.name || "";
    return full.replaceAll(" > ", " › ");
  }

  async function collect(item: EntitySummary) {
    if ((await move([item], props.box)) > 0) {
      movedIds.value.push(item.id);
      emit("moved");
    }
  }
</script>
