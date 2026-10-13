<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        size="icon"
        class="relative"
        :variant="offlineState.online && !offlineState.needsLogin ? 'default' : 'destructive'"
        :aria-label="$t('offline.status_button')"
        data-testid="offline-status"
      >
        <MdiCloudOffOutline v-if="!offlineState.online" />
        <MdiCloudSync
          v-else-if="offlineState.syncing || pending > 0"
          :class="{ 'animate-pulse': offlineState.syncing }"
        />
        <MdiCloudCheckOutline v-else />
        <span
          v-if="pending > 0 || failed.length > 0"
          class="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white"
          data-testid="offline-pending-count"
        >
          {{ pending + failed.length }}
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-80" align="end">
      <div class="flex flex-col gap-3 text-sm">
        <div class="flex items-center gap-2 font-semibold">
          <MdiCloudOffOutline v-if="!offlineState.online" class="size-5 text-destructive" />
          <MdiCloudCheckOutline v-else class="size-5 text-primary" />
          {{ offlineState.online ? $t("offline.online") : $t("offline.offline") }}
        </div>

        <p class="text-muted-foreground">
          <template v-if="offlineState.lastSnapshotAt">
            {{ $t("offline.available", { count: offlineState.entityCount }) }}
            <br />
            {{ $t("offline.last_sync", { time: fmtDate(new Date(offlineState.lastSnapshotAt), "relative") }) }}
          </template>
          <template v-else>{{ $t("offline.never_synced") }}</template>
        </p>

        <div v-if="offlineState.syncing" class="flex flex-col gap-1">
          <span>{{ phaseLabel }}</span>
          <Progress v-if="offlineState.progressTotal > 0" :model-value="progressPct" />
        </div>

        <p v-if="offlineState.needsLogin" class="font-medium text-destructive">{{ $t("offline.needs_login") }}</p>

        <div v-if="pending > 0">
          <p class="font-medium">{{ $t("offline.pending", { count: pending }) }}</p>
          <ul class="ml-4 list-disc text-muted-foreground">
            <li v-for="entry in pendingEntries" :key="entry.seq">{{ describe(entry) }}</li>
          </ul>
        </div>

        <div v-if="failed.length > 0" class="flex flex-col gap-1">
          <p class="font-medium text-destructive">{{ $t("offline.failed", { count: failed.length }) }}</p>
          <div v-for="entry in failed" :key="entry.seq" class="flex items-start gap-2 rounded border p-2">
            <div class="grow">
              <div>{{ describe(entry) }}</div>
              <div class="break-all text-xs text-muted-foreground">{{ entry.error }}</div>
            </div>
            <Button size="sm" variant="outline" @click="discard(entry)">{{ $t("offline.discard") }}</Button>
          </div>
        </div>

        <Button :disabled="offlineState.syncing" data-testid="offline-sync-now" @click="$offlineSync(true)">
          <MdiCloudSync class="mr-2" />
          {{ $t("offline.sync_now") }}
        </Button>
        <p class="text-xs text-muted-foreground">{{ $t("offline.hint") }}</p>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import MdiCloudOffOutline from "~icons/mdi/cloud-off-outline";
  import MdiCloudSync from "~icons/mdi/cloud-sync";
  import MdiCloudCheckOutline from "~icons/mdi/cloud-check-outline";
  import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
  import { Button } from "@/components/ui/button";
  import { Progress } from "@/components/ui/progress";
  import { toast } from "@/components/ui/sonner";
  import { offlineState, pendingCount, failedEntries } from "~~/lib/offline/state";
  import { discardOutboxEntry } from "~~/lib/offline/sync";
  import type { OutboxEntry } from "~~/lib/offline/store";

  const { t } = useI18n();
  const { $offlineSync } = useNuxtApp();

  const pending = computed(() => pendingCount());
  const failed = computed(() => failedEntries());
  const pendingEntries = computed(() => offlineState.outbox.filter(e => !e.error));
  const progressPct = computed(() =>
    offlineState.progressTotal > 0 ? Math.round((offlineState.progressDone / offlineState.progressTotal) * 100) : 0
  );

  const phaseLabel = computed(() => {
    const p = { done: offlineState.progressDone, total: offlineState.progressTotal };
    switch (offlineState.phase) {
      case "upload":
        return t("offline.phase.upload", p);
      case "list":
        return t("offline.phase.list");
      case "details":
        return t("offline.phase.details", p);
      case "images":
        return t("offline.phase.images", p);
      default:
        return t("offline.phase.list");
    }
  });

  function nameOf(entityId: string): string {
    const create = offlineState.outbox.find(e => e.kind === "create" && e.tempId === entityId);
    return create && create.kind === "create" ? String(create.body.name ?? "") : "";
  }

  function describe(entry: OutboxEntry): string {
    if (entry.kind === "create") {
      return t("offline.entry.create", { name: String(entry.body.name ?? "") });
    }
    if (entry.kind === "move") {
      return t("offline.entry.move", { name: entry.entityName, target: entry.targetName });
    }
    return t("offline.entry.photo", { name: nameOf(entry.entityId) || entry.fileName });
  }

  async function discard(entry: OutboxEntry) {
    if (entry.seq !== undefined) await discardOutboxEntry(entry.seq);
  }

  // One toast per burst: creating an item with photos queues several entries.
  let lastQueuedToast = 0;
  watch(
    () => offlineState.queuedAt,
    at => {
      if (at - lastQueuedToast < 5000) return;
      lastQueuedToast = at;
      toast.info(t("offline.toast.queued"));
    }
  );
  watch(
    () => offlineState.blockedAt,
    () => toast.warning(t("offline.toast.blocked"))
  );
  watch(
    () => offlineState.syncedAt,
    () => toast.success(t("offline.toast.synced", { count: offlineState.syncedCount }))
  );
</script>
