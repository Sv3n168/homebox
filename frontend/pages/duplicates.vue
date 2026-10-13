<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntityOut, EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiMerge from "~icons/mdi/call-merge";
  import MdiPackageVariantClosed from "~icons/mdi/package-variant-closed";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Checkbox } from "@/components/ui/checkbox";
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
  // Entries left out of a merge ("not part of this") and the group awaiting a yes.
  const excluded = ref<Record<string, string[]>>({});
  const confirming = ref<string | null>(null);

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
  const isIncluded = (g: EntitySummary[], id: string) =>
    id === keptId(g) || !(excluded.value[groupKey(g)] ?? []).includes(id);
  const mergedAway = (g: EntitySummary[]) => g.filter(i => i.id !== keptId(g) && isIncluded(g, i.id));
  const keptItem = (g: EntitySummary[]) => g.find(i => i.id === keptId(g))!;
  const totalQuantity = (g: EntitySummary[]) =>
    [keptItem(g), ...mergedAway(g)].reduce((sum, i) => sum + (i.quantity || 0), 0);

  function toggleIncluded(g: EntitySummary[], id: string) {
    const key = groupKey(g);
    const list = excluded.value[key] ?? [];
    excluded.value = { ...excluded.value, [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id] };
    confirming.value = null;
  }

  function pickKeep(g: EntitySummary[], id: string) {
    const key = groupKey(g);
    keep.value = { ...keep.value, [key]: id };
    excluded.value = { ...excluded.value, [key]: (excluded.value[key] ?? []).filter(x => x !== id) };
    confirming.value = null;
  }

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

  // Only runs after the summary was confirmed; nothing is merged on its own.
  async function merge(g: EntitySummary[]) {
    const key = groupKey(g);
    const away = mergedAway(g);
    if (confirming.value !== key || away.length === 0) return;
    confirming.value = null;
    busy.value = key;
    try {
      const targetId = keptId(g);
      const target = await full(targetId);
      const others = await Promise.all(away.map(i => full(i.id)));

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
      <div v-for="i in g" :key="i.id" class="flex items-center gap-2">
        <button
          type="button"
          class="flex min-w-0 grow items-center gap-3 rounded-xl p-2 text-left"
          :class="[
            keptId(g) === i.id ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-accent',
            { 'opacity-50': !isIncluded(g, i.id) },
          ]"
          :aria-pressed="keptId(g) === i.id"
          data-testid="duplicate-keep"
          @click="pickKeep(g, i.id)"
        >
          <div class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            <img v-if="thumb(i)" :src="thumb(i)!" alt="" class="size-full object-cover" />
            <MdiPackageVariantClosed v-else class="size-6 text-muted-foreground" />
          </div>
          <div class="min-w-0 grow">
            <div class="truncate font-medium">{{ i.name }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ i.quantity }}× · {{ pathOf(i) }}</div>
          </div>
        </button>
        <label
          v-if="keptId(g) !== i.id"
          class="flex shrink-0 cursor-pointer flex-col items-center gap-1 px-1 text-[11px] text-muted-foreground"
        >
          <Checkbox
            :model-value="isIncluded(g, i.id)"
            data-testid="duplicate-include"
            @update:model-value="toggleIncluded(g, i.id)"
          />
          {{ $t("duplicates.include") }}
        </label>
      </div>

      <div
        v-if="confirming === groupKey(g)"
        class="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm"
        data-testid="duplicate-confirm"
      >
        <p class="font-medium">{{ $t("duplicates.confirm.title") }}</p>
        <ul class="list-disc space-y-1 pl-5">
          <li>
            {{
              $t("duplicates.confirm.keep", {
                name: keptItem(g).name,
                place: pathOf(keptItem(g)),
                count: totalQuantity(g),
              })
            }}
          </li>
          <li v-for="o in mergedAway(g)" :key="o.id">
            {{ $t("duplicates.confirm.archive", { name: o.name, place: pathOf(o) }) }}
          </li>
          <li>{{ $t("duplicates.confirm.carry") }}</li>
        </ul>
        <div class="flex gap-2 pt-1">
          <Button variant="outline" class="flex-1" @click="confirming = null">{{ $t("global.cancel") }}</Button>
          <Button class="flex-1" :disabled="busy !== null" data-testid="duplicate-confirm-yes" @click="merge(g)">
            {{ $t("duplicates.confirm.yes") }}
          </Button>
        </div>
      </div>
      <div v-else class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1" data-testid="duplicate-ignore" @click="notDuplicate(g)">
          {{ $t("duplicates.not_duplicate") }}
        </Button>
        <Button
          class="flex-1"
          :disabled="busy !== null || mergedAway(g).length === 0"
          data-testid="duplicate-merge"
          @click="confirming = groupKey(g)"
        >
          <MdiMerge />
          {{ $t("duplicates.merge") }}
        </Button>
      </div>
    </Card>
  </BaseContainer>
</template>
