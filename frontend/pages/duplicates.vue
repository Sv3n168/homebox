<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntityOut, EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiMerge from "~icons/mdi/call-merge";
  import MdiPackageVariantClosed from "~icons/mdi/package-variant-closed";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import BaseContainer from "@/components/Base/Container.vue";
  import { entityToUpdate, findDuplicateGroups, mergeInto, pairKey } from "~/lib/cleanup/duplicates";

  // Likely duplicates side by side: merge them into one entry (the others are
  // archived, not deleted) or mark them as different things.

  definePageMeta({ middleware: ["auth"] });
  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("duplicates.title") });

  const api = useUserApi();
  const tree = useFlatLocations();
  const ignored = useLocalStorage<string[]>("homebox/duplicates/ignored", []);

  const items = ref<EntitySummary[]>([]);
  const loading = ref(true);
  const busy = ref<string | null>(null);
  const keep = ref<Record<string, string>>({});

  const groups = computed(() => findDuplicateGroups(items.value, new Set(ignored.value)));
  const groupKey = (g: EntitySummary[]) =>
    g
      .map(i => i.id)
      .sort()
      .join(",");

  // Default to keep: the entry with a photo, then more tags, then the oldest.
  function defaultKeep(g: EntitySummary[]) {
    return [...g].sort(
      (a, b) =>
        Number(!!b.imageId) - Number(!!a.imageId) ||
        (b.tags?.length ?? 0) - (a.tags?.length ?? 0) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0]!.id;
  }
  const keptId = (g: EntitySummary[]) => keep.value[groupKey(g)] ?? defaultKeep(g);

  async function load() {
    loading.value = true;
    const { data, error } = await api.items.getAll({ page: -1, pageSize: -1, orderBy: "name" });
    loading.value = false;
    if (error) {
      toast.error(t("duplicates.toast.load_failed"));
      return;
    }
    items.value = data.items;
  }

  function pathOf(i: EntitySummary) {
    const id = i.parent?.id;
    return ((id && tree.value.find(l => l.id === id)?.treeString) || i.parent?.name || "").replaceAll(" > ", " › ");
  }

  function thumb(i: EntitySummary) {
    const id = i.thumbnailId || i.imageId;
    return id ? api.authURL(`/entities/${i.id}/attachments/${id}`) : null;
  }

  function notDuplicate(g: EntitySummary[]) {
    const pairs: string[] = [];
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) pairs.push(pairKey(g[i]!.id, g[j]!.id));
    ignored.value = [...new Set([...ignored.value, ...pairs])];
  }

  async function full(id: string): Promise<EntityOut> {
    const { data, error } = await api.items.get(id);
    if (error) throw new Error("load " + id);
    return data;
  }

  async function merge(g: EntitySummary[]) {
    const key = groupKey(g);
    busy.value = key;
    try {
      const targetId = keptId(g);
      const target = await full(targetId);
      const others = await Promise.all(g.filter(i => i.id !== targetId).map(i => full(i.id)));

      const { error } = await api.items.update(targetId, mergeInto(target, others));
      if (error) throw new Error("update");

      // Photos come along; documents stay on the archived entry.
      for (const o of others) {
        for (const a of o.attachments.filter(a => a.type === "photo")) {
          const r = await fetch(api.authURL(`/entities/${o.id}/attachments/${a.id}`));
          if (r.ok)
            await api.items.attachments.add(targetId, await r.blob(), a.title || "photo.jpg", "photo" as never, false);
        }
        const { error: archiveError } = await api.items.update(o.id, { ...entityToUpdate(o), archived: true });
        if (archiveError) throw new Error("archive");
      }

      items.value = items.value.filter(i => !others.some(o => o.id === i.id));
      toast.success(t("duplicates.toast.merged", { name: target.name }));
    } catch (e) {
      console.error(e);
      toast.error(t("duplicates.toast.merge_failed"));
    } finally {
      busy.value = null;
    }
  }

  onMounted(load);
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header>
      <h1 class="text-2xl font-semibold">{{ $t("duplicates.title") }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("duplicates.intro") }}</p>
    </header>

    <p v-if="loading" class="text-muted-foreground">{{ $t("tag_assistant.loading") }}</p>

    <Card
      v-else-if="groups.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="duplicates-none"
    >
      <MdiCheckCircle class="size-12 text-primary" />
      <p class="text-lg font-medium">{{ $t("duplicates.none") }}</p>
    </Card>

    <Card v-for="g in groups" v-else :key="groupKey(g)" class="flex flex-col gap-2 p-3" data-testid="duplicate-group">
      <p class="px-1 text-xs font-medium uppercase text-muted-foreground">{{ $t("duplicates.keep_which") }}</p>
      <label
        v-for="i in g"
        :key="i.id"
        class="flex cursor-pointer items-center gap-3 rounded-xl p-2"
        :class="keptId(g) === i.id ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-accent'"
      >
        <input v-model="keep[groupKey(g)]" type="radio" :value="i.id" class="sr-only" />
        <div class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          <img v-if="thumb(i)" :src="thumb(i)!" alt="" class="size-full object-cover" />
          <MdiPackageVariantClosed v-else class="size-6 text-muted-foreground" />
        </div>
        <div class="min-w-0 grow">
          <div class="truncate font-medium">{{ i.name }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ i.quantity }}× · {{ pathOf(i) }}</div>
        </div>
      </label>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1" data-testid="duplicate-ignore" @click="notDuplicate(g)">
          {{ $t("duplicates.not_duplicate") }}
        </Button>
        <Button class="flex-1" :disabled="busy !== null" data-testid="duplicate-merge" @click="merge(g)">
          <MdiMerge />
          {{ $t("duplicates.merge") }}
        </Button>
      </div>
    </Card>
  </BaseContainer>
</template>
