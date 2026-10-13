<template>
  <div
    v-if="!offlineState.online"
    class="flex items-center justify-center gap-2 bg-amber-500 px-3 py-1 text-center text-sm font-medium text-white"
    data-testid="offline-banner"
  >
    <MdiCloudOffOutline class="size-4 shrink-0" />
    <span>
      {{ $t("offline.banner") }}
      <template v-if="offlineState.lastSnapshotAt">
        ·
        {{ $t("offline.banner_as_of", { time: fmtDate(new Date(offlineState.lastSnapshotAt), "short", "datetime") }) }}
      </template>
      <template v-if="pending > 0"> · {{ $t("offline.pending", { count: pending }) }}</template>
    </span>
  </div>
</template>

<script setup lang="ts">
  import MdiCloudOffOutline from "~icons/mdi/cloud-off-outline";
  import { offlineState, pendingCount } from "~~/lib/offline/state";

  const pending = computed(() => pendingCount());
</script>
