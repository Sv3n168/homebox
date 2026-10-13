<script setup lang="ts">
  import ItemCard from "@/components/Item/Card.vue";
  import type { EntitySummary } from "~/lib/api/types/data-contracts";
  import type { Table as TableType } from "@tanstack/vue-table";
  import MdiSelectSearch from "~icons/mdi/select-search";
  import { Checkbox } from "@/components/ui/checkbox";
  import DropdownAction from "./data-table-dropdown.vue";
  import ItemListRow from "@/components/Item/ListRow.vue";
  import { useI18n } from "vue-i18n";
  import MdiFolderMoveOutline from "~icons/mdi/folder-move-outline";
  import MdiClose from "~icons/mdi/close";
  import { Button } from "@/components/ui/button";

  const preferences = useViewPreferences();

  const props = defineProps<{
    table: TableType<EntitySummary>;
    locationFlatTree?: FlatTreeItem[];
    /** One row per item instead of picture cards. */
    compact?: boolean;
  }>();

  const selectedCount = computed(() => props.table.getSelectedRowModel().rows.length);

  // List view: tick several items, then move them in one go (box picker, undo, offline).
  const { t } = useI18n();
  const { pick } = useBoxPicker();
  const { move } = useMove();
  const emit = defineEmits<{ (e: "refresh"): void }>();
  async function moveSelected() {
    const items = props.table.getSelectedRowModel().rows.map(r => r.original);
    const box = await pick({ title: t("move.title_many", { count: items.length }), scan: false });
    if (box && (await move(items, box)) > 0) {
      props.table.resetRowSelection();
      emit("refresh");
    }
  }
</script>

<template>
  <Teleport to="#selectable-subtitle" defer>
    <Checkbox
      class="size-6 p-0"
      :model-value="
        table.getIsAllPageRowsSelected() ? true : table.getSelectedRowModel().rows.length > 0 ? 'indeterminate' : false
      "
      :aria-label="$t('components.item.view.selectable.select_all')"
      @update:model-value="table.toggleAllPageRowsSelected(!!$event)"
    />

    <div class="grow" />

    <div :class="['relative inline-flex items-center', selectedCount === 0 ? 'pointer-events-none opacity-50' : '']">
      <DropdownAction
        :multi="{ items: table.getSelectedRowModel().rows, columns: table.getAllColumns() }"
        view="card"
        :table="table"
        @refresh="emit('refresh')"
      />

      <span v-if="selectedCount > 0" class="absolute -right-1 -top-1 flex size-4">
        <span
          class="pointer-events-none relative flex size-4 items-center justify-center whitespace-nowrap rounded-full bg-primary p-1 text-xs text-primary-foreground"
        >
          {{ String(selectedCount) }}
        </span>
      </span>
    </div>
  </Teleport>
  <div v-if="table.getRowModel().rows?.length === 0" class="flex flex-col items-center gap-2">
    <MdiSelectSearch class="size-10" />
    <p>{{ $t("items.no_results") }}</p>
  </div>
  <div v-else-if="compact" class="divide-y overflow-hidden rounded-xl border bg-card">
    <ItemListRow
      v-for="item in table.getRowModel().rows"
      :key="item.original.id"
      :item="item.original"
      :table-row="item"
      :location-flat-tree="locationFlatTree"
    />
  </div>
  <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
    <ItemCard
      v-for="item in table.getRowModel().rows"
      :key="item.original.id"
      :item="item.original"
      :table-row="preferences.quickActions.enabled ? item : undefined"
      :location-flat-tree="locationFlatTree"
    />
  </div>
  <div
    v-if="compact && selectedCount > 0"
    class="fixed inset-x-3 bottom-24 z-30 mx-auto flex max-w-md items-center gap-2 rounded-2xl border bg-[hsl(var(--popover))] p-2 pl-4 shadow-xl sm:bottom-6"
    data-testid="selection-bar"
  >
    <span class="grow text-sm font-medium">{{ $t("move.selected", { count: selectedCount }) }}</span>
    <Button size="sm" data-testid="selection-move" @click="moveSelected">
      <MdiFolderMoveOutline />
      {{ $t("move.button") }}
    </Button>
    <Button
      size="icon"
      variant="ghost"
      class="size-8"
      :aria-label="$t('global.cancel')"
      @click="table.resetRowSelection()"
    >
      <MdiClose />
    </Button>
  </div>
</template>
