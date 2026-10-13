<template>
  <div
    v-if="!offlineState.online"
    class="flex items-center justify-center gap-1.5 truncate bg-amber-500/10 px-3 py-0.5 text-xs text-amber-700 backdrop-blur dark:text-amber-300"
    data-testid="offline-banner"
  >
    <MdiCloudOffOutline class="size-3.5 shrink-0" />
    <span class="truncate">
      {{ $t("offline.banner") }}
      <template v-if="offlineState.lastSnapshotAt">
        ·
        {{ $t("offline.banner_as_of", { time: fmtDate(new Date(offlineState.lastSnapshotAt), "short", "datetime") }) }}
      </template>
      <template v-if="pending > 0"> · {{ $t("offline.banner_pending", { count: pending }) }}</template>
    </span>
  </div>
</template>

<script setup lang="ts">
  import MdiCloudOffOutline from "~icons/mdi/cloud-off-outline";
  import { offlineState, pendingCount } from "~~/lib/offline/state";

  const pending = computed(() => pendingCount());
</script>
