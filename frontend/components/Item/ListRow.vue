<template>
  <div
    class="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40"
    :class="{ 'bg-primary/5': tableRow?.getIsSelected() }"
    data-testid="item-list-row"
  >
    <Checkbox
      v-if="tableRow"
      class="size-5 shrink-0"
      :model-value="tableRow.getIsSelected()"
      :aria-label="$t('components.item.view.selectable.select_card')"
      @update:model-value="tableRow.toggleSelected()"
    />
    <NuxtLink :to="link" class="flex min-w-0 grow items-center gap-3">
      <div class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
        <img v-if="thumbUrl" :src="thumbUrl" :alt="item.name" loading="lazy" class="size-full object-cover" />
        <MdiPackageVariantClosed v-else-if="!isLocation" class="size-7 text-muted-foreground" />
        <MdiArchiveOutline v-else class="size-7 text-muted-foreground" />
      </div>
      <div class="min-w-0 grow">
        <div class="truncate font-semibold">{{ item.name }}</div>
        <div v-if="path" class="truncate text-sm text-muted-foreground">{{ path }}</div>
        <div v-if="lent || pending" class="mt-1 flex flex-wrap gap-1">
          <ItemLentBadge v-if="lent" :item="item" compact />
          <Badge v-if="pending" class="gap-1 bg-sky-600 text-white hover:bg-sky-600/80">
            <MdiCloudUploadOutline class="size-3.5" />
            {{ $t("offline.not_synced") }}
          </Badge>
        </div>
      </div>
      <Badge variant="secondary" class="shrink-0 tabular-nums">{{ item.quantity }}</Badge>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
  import type { Row } from "@tanstack/vue-table";
  import type { EntityOut, EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiPackageVariantClosed from "~icons/mdi/package-variant-closed";
  import MdiArchiveOutline from "~icons/mdi/archive-outline";
  import MdiCloudUploadOutline from "~icons/mdi/cloud-upload-outline";
  import { Badge } from "@/components/ui/badge";
  import { Checkbox } from "@/components/ui/checkbox";
  import ItemLentBadge from "~/components/Item/LentBadge.vue";
  import { isLent } from "~/lib/lending";
  import { PENDING_FLAG } from "~/lib/offline/query";

  const props = defineProps<{
    item: EntitySummary | EntityOut;
    locationFlatTree?: FlatTreeItem[];
    tableRow?: Row<EntitySummary> | null;
  }>();

  const api = useUserApi();
  const fallbackTree = useFlatLocations();

  const isLocation = computed(() => !!props.item.entityType?.isLocation);
  const link = computed(() => `/${isLocation.value ? "location" : "item"}/${props.item.id}`);
  const lent = computed(() => isLent(props.item));
  const pending = computed(() => PENDING_FLAG in props.item);

  const thumbUrl = computed(() => {
    const id = props.item.thumbnailId || props.item.imageId;
    return id ? api.authURL(`/entities/${props.item.id}/attachments/${id}`) : null;
  });

  // Full path of where it is stored, e.g. "Keller > Regal 1 > Kiste 3".
  const path = computed(() => {
    const parentId = props.item.parent?.id;
    if (!parentId) return "";
    const tree = props.locationFlatTree?.length ? props.locationFlatTree : fallbackTree.value;
    const full = tree.find(l => l.id === parentId)?.treeString || props.item.parent?.name || "";
    // The last two levels ("Regal 1 › Kiste 3") fit on a phone and say where to look.
    return full.split(" > ").slice(-2).join(" › ");
  });
</script>
