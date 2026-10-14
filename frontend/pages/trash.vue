<script setup lang="ts">
  // Fork: recycle bin. Deleted items and locations (with their contents) stay
  // 30 days and can be restored; see backend repo/fork_trash.go.
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import MdiDeleteEmpty from "~icons/mdi/delete-empty-outline";
  import MdiDeleteForever from "~icons/mdi/delete-forever-outline";
  import MdiRestore from "~icons/mdi/restore";
  import MdiPackageVariant from "~icons/mdi/package-variant";
  import MdiMapMarker from "~icons/mdi/map-marker-outline";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import BaseContainer from "@/components/Base/Container.vue";
  import type { TrashEntry } from "~/composables/use-trash";

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("trash.title") });

  const trash = useTrash();
  const confirm = useConfirm();

  const entries = ref<TrashEntry[]>([]);
  const loading = ref(true);
  const busy = ref<string | null>(null);

  async function load() {
    const { data, error } = await trash.list();
    loading.value = false;
    if (error) {
      toast.error(t("trash.toast.failed"));
      return;
    }
    entries.value = data;
  }

  async function restore(e: TrashEntry) {
    busy.value = e.id;
    const { data, error, status } = await trash.restore(e.id);
    busy.value = null;
    if (error) {
      toast.error(status === 409 ? t("trash.toast.type_missing") : t("trash.toast.failed"));
      return;
    }
    entries.value = entries.value.filter(x => x.id !== e.id);
    toast.success(t("trash.toast.restored", { name: e.name }), {
      action: {
        label: t("trash.toast.open"),
        onClick: () => navigateTo(e.isLocation ? `/location/${data.id}` : `/item/${data.id}`),
      },
    });
  }

  async function purge(e: TrashEntry) {
    const { isCanceled } = await confirm.open(t("trash.confirm_purge", { name: e.name }));
    if (isCanceled) return;
    busy.value = e.id;
    const { error } = await trash.purge(e.id);
    busy.value = null;
    if (error) {
      toast.error(t("trash.toast.failed"));
      return;
    }
    entries.value = entries.value.filter(x => x.id !== e.id);
    toast.success(t("trash.toast.purged"));
  }

  async function emptyAll() {
    const { isCanceled } = await confirm.open(t("trash.confirm_empty"));
    if (isCanceled) return;
    busy.value = "all";
    const { error } = await trash.empty();
    busy.value = null;
    if (error) {
      toast.error(t("trash.toast.failed"));
      return;
    }
    entries.value = [];
    toast.success(t("trash.toast.emptied"));
  }

  onMounted(load);
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ $t("trash.title") }}</h1>
        <p class="text-sm text-muted-foreground">{{ $t("trash.intro") }}</p>
      </div>
      <Button
        v-if="entries.length > 0"
        variant="outline"
        :disabled="busy !== null"
        data-testid="trash-empty-all"
        @click="emptyAll"
      >
        <MdiDeleteForever />
        {{ $t("trash.empty_all") }}
      </Button>
    </header>

    <p v-if="loading" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card
      v-else-if="entries.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="trash-empty"
    >
      <MdiDeleteEmpty class="size-12 text-muted-foreground" />
      <p class="text-lg font-medium">{{ $t("trash.empty") }}</p>
    </Card>

    <Card v-else class="divide-y overflow-hidden">
      <div
        v-for="e in entries"
        :key="e.id"
        class="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap"
        data-testid="trash-entry"
      >
        <div class="flex min-w-0 basis-full items-start gap-3 sm:grow sm:basis-auto">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <MdiMapMarker v-if="e.isLocation" class="size-5" />
            <MdiPackageVariant v-else class="size-5" />
          </div>
          <div class="min-w-0 grow">
            <p class="truncate font-medium">{{ e.name }}</p>
            <p class="text-sm text-muted-foreground">
              <template v-if="e.parentName">{{ $t("trash.from", { name: e.parentName }) }} · </template>
              <template v-if="e.entityCount > 1">{{ $t("trash.contains", { count: e.entityCount - 1 }) }} · </template>
              {{ $t("trash.deleted_at", { when: fmtDate(e.deletedAt, "relative") }) }}
            </p>
            <p class="text-xs text-muted-foreground">
              {{ $t("trash.purge_at", { date: fmtDate(e.purgeAt, "human", "date") }) }}
            </p>
          </div>
        </div>
        <div class="flex w-full gap-2 sm:w-auto">
          <Button
            size="sm"
            class="flex-1 sm:flex-none"
            :disabled="busy !== null"
            data-testid="trash-restore"
            @click="restore(e)"
          >
            <MdiRestore />
            {{ $t("trash.restore") }}
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="flex-1 sm:flex-none"
            :aria-label="$t('trash.purge')"
            :disabled="busy !== null"
            data-testid="trash-purge"
            @click="purge(e)"
          >
            <MdiDeleteForever />
            <span class="sm:hidden">{{ $t("trash.purge") }}</span>
          </Button>
        </div>
      </div>
    </Card>
  </BaseContainer>
</template>
