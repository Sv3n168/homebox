<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheck from "~icons/mdi/check";
  import MdiClose from "~icons/mdi/close";
  import MdiFolderMoveOutline from "~icons/mdi/folder-move-outline";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiArrowRight from "~icons/mdi/arrow-right";
  import MdiHistory from "~icons/mdi/history";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Progress } from "@/components/ui/progress";
  import ItemListRow from "~/components/Item/ListRow.vue";
  import MdiHandExtended from "~icons/mdi/hand-extended";
  import { isLent } from "~/lib/lending";

  // Mini inventory of one box: tick off what is there, flag what is missing
  // (tag "Vermisst"), move what belongs elsewhere. Stored in Homebox itself.
  // Answers are kept on the device until the check is finished, so leaving the
  // page (or the phone locking in the basement) does not lose them.

  definePageMeta({ middleware: ["auth"] });

  type Verdict = "present" | "missing";
  type Moved = { name: string; to: { id: string; name: string } };
  type Draft = { verdicts: Record<string, Verdict>; moved: Record<string, Moved>; at: number };

  const DRAFT_DAYS = 14;

  const { t } = useI18n();
  const route = useRoute();
  const api = useUserApi();
  const { pick } = useBoxPicker();
  const { move } = useMove();
  const missingTag = useMissingTag();

  const boxId = computed(() => route.params.id as string);
  const boxName = ref("");
  const items = ref<EntitySummary[]>([]);
  // Lent out: not in the box right now, but not missing either; not asked about.
  const lent = ref<EntitySummary[]>([]);
  const verdicts = ref<Record<string, Verdict>>({});
  const moved = ref<Record<string, Moved>>({});
  const loading = ref(true);
  const saving = ref(false);
  const finished = ref(false);
  const restored = ref(false);
  // What the summary lists after finishing (kept after the draft is cleared).
  const summary = ref<{ missing: EntitySummary[]; moved: [string, Moved][] }>({ missing: [], moved: [] });

  useHead({ title: () => "HomeBox | " + t("box_check.title", { name: boxName.value }) });

  const draftKey = computed(() => `homebox/box-check/${boxId.value}`);

  function readDraft(): Draft | null {
    try {
      const raw = localStorage.getItem(draftKey.value);
      if (!raw) return null;
      const d = JSON.parse(raw) as Draft;
      if (Date.now() - d.at > DRAFT_DAYS * 864e5) return null;
      return d;
    } catch {
      return null;
    }
  }

  function writeDraft() {
    try {
      if (Object.keys(verdicts.value).length === 0 && Object.keys(moved.value).length === 0) {
        localStorage.removeItem(draftKey.value);
        return;
      }
      const d: Draft = { verdicts: verdicts.value, moved: moved.value, at: Date.now() };
      localStorage.setItem(draftKey.value, JSON.stringify(d));
    } catch {
      // storage unavailable: the check still works, it just is not remembered
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(draftKey.value);
    } catch {
      // nothing stored
    }
  }

  const movedCount = computed(() => Object.keys(moved.value).length);
  const total = computed(() => items.value.length + movedCount.value);
  const checked = computed(() => items.value.filter(i => verdicts.value[i.id]).length + movedCount.value);
  const progress = computed(() => (total.value ? Math.round((checked.value / total.value) * 100) : 100));
  const missingCount = computed(() => items.value.filter(i => verdicts.value[i.id] === "missing").length);

  async function load() {
    loading.value = true;
    const [box, list] = await Promise.all([
      api.items.getLocation(boxId.value),
      api.items.getAll({ parentIds: [boxId.value], page: -1, pageSize: -1, orderBy: "name" }),
    ]);
    loading.value = false;
    if (box.error || list.error) {
      toast.error(t("box_check.toast.load_failed"));
      return;
    }
    boxName.value = box.data.name;
    const inBox = list.data.items.filter(i => !i.entityType?.isLocation);

    const draft = readDraft();
    if (draft) {
      const ids = new Set(inBox.map(i => i.id));
      // An item moved back (undo) is in the box again and gets checked normally.
      moved.value = Object.fromEntries(Object.entries(draft.moved ?? {}).filter(([id]) => !ids.has(id)));
      verdicts.value = Object.fromEntries(Object.entries(draft.verdicts ?? {}).filter(([id]) => ids.has(id)));
      restored.value = Object.keys(verdicts.value).length > 0 || Object.keys(moved.value).length > 0;
    }
    lent.value = inBox.filter(i => isLent(i));
    items.value = inBox.filter(i => !isLent(i));
  }

  function set(id: string, v: Verdict) {
    verdicts.value = { ...verdicts.value, [id]: v };
    writeDraft();
  }

  async function elsewhere(item: EntitySummary) {
    const box = await pick({ title: t("move.title", { name: item.name }), exclude: [boxId.value] });
    if (!box || (await move([item], box)) === 0) return;
    moved.value = { ...moved.value, [item.id]: { name: item.name, to: { id: box.id, name: box.name } } };
    const { [item.id]: _, ...rest } = verdicts.value;
    verdicts.value = rest;
    items.value = items.value.filter(i => i.id !== item.id);
    writeDraft();
  }

  function allPresent() {
    const next = { ...verdicts.value };
    for (const i of items.value) if (!next[i.id]) next[i.id] = "present";
    verdicts.value = next;
    writeDraft();
  }

  function startOver() {
    verdicts.value = {};
    moved.value = {};
    restored.value = false;
    clearDraft();
    load();
  }

  async function saveTags(): Promise<number> {
    const tagId = missingCount.value > 0 ? await missingTag.ensure() : (missingTag.tag.value?.id ?? null);
    if (!tagId) return missingCount.value > 0 ? -1 : 0;
    let failed = 0;
    for (const item of items.value) {
      const v = verdicts.value[item.id];
      const ids = item.tags.map(tg => tg.id);
      const has = ids.includes(tagId);
      let next: string[] | null = null;
      if (v === "missing" && !has) next = [...ids, tagId];
      else if (v === "present" && has) next = ids.filter(id => id !== tagId);
      if (!next) continue;
      const { error } = await api.items.patch(item.id, { id: item.id, tagIds: next });
      if (error) failed++;
    }
    return failed;
  }

  // Offline (basement) the date is queued and set once the server is reachable.
  const { setField } = useBoxField();
  const stampBox = () => setField(boxId.value, CHECKED_FIELD, isoToday());

  async function finish() {
    saving.value = true;
    const failed = await saveTags();
    const stamped = await stampBox();
    saving.value = false;
    if (failed !== 0 || !stamped) {
      toast.error(t("box_check.toast.save_failed"));
      return;
    }
    summary.value = {
      missing: items.value.filter(i => verdicts.value[i.id] === "missing"),
      moved: Object.entries(moved.value),
    };
    finished.value = true;
    clearDraft();
    try {
      sessionStorage.removeItem(CHECK_REMINDER_CACHE);
    } catch {
      // nothing cached
    }
    toast.success(t("box_check.toast.saved"));
  }

  onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <header class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">{{ $t("box_check.title", { name: boxName }) }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("box_check.intro") }}</p>
      <template v-if="!loading && !finished && total">
        <Progress :model-value="progress" />
        <p class="text-sm text-muted-foreground" data-testid="box-check-progress">
          {{ $t("box_check.progress", { done: checked, total }) }}
        </p>
      </template>
    </header>

    <p v-if="loading" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card v-else-if="finished" class="flex flex-col gap-4 p-6" data-testid="box-check-done">
      <div class="flex flex-col items-center gap-2 text-center">
        <MdiCheckCircle class="size-12 text-primary" />
        <p class="text-lg font-medium">{{ $t("box_check.done", { missing: summary.missing.length }) }}</p>
      </div>
      <div v-if="summary.missing.length" class="flex flex-col gap-1" data-testid="box-check-summary-missing">
        <p class="text-sm font-medium">{{ $t("box_check.summary_missing") }}</p>
        <ul class="flex flex-col gap-1 text-sm">
          <li v-for="item in summary.missing" :key="item.id" class="flex items-center gap-2">
            <MdiClose class="size-4 shrink-0 text-destructive" />
            <NuxtLink :to="`/item/${item.id}`" class="truncate hover:underline">{{ item.name }}</NuxtLink>
          </li>
        </ul>
      </div>
      <div v-if="summary.moved.length" class="flex flex-col gap-1" data-testid="box-check-summary-moved">
        <p class="text-sm font-medium">{{ $t("box_check.summary_moved") }}</p>
        <ul class="flex flex-col gap-1 text-sm">
          <li v-for="[id, m] in summary.moved" :key="id" class="flex min-w-0 items-center gap-2">
            <MdiFolderMoveOutline class="size-4 shrink-0 text-muted-foreground" />
            <NuxtLink :to="`/item/${id}`" class="truncate hover:underline">{{ m.name }}</NuxtLink>
            <MdiArrowRight class="size-4 shrink-0 text-muted-foreground" />
            <NuxtLink :to="`/location/${m.to.id}`" class="truncate hover:underline">{{ m.to.name }}</NuxtLink>
          </li>
        </ul>
      </div>
      <div class="flex flex-wrap justify-center gap-2">
        <Button v-if="summary.missing.length" as-child variant="outline">
          <NuxtLink to="/missing">{{ $t("box_check.missing_all") }}</NuxtLink>
        </Button>
        <Button as-child variant="outline">
          <NuxtLink :to="`/location/${boxId}`">{{ $t("box_check.back") }}</NuxtLink>
        </Button>
      </div>
    </Card>

    <template v-else>
      <div
        v-if="restored"
        class="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
        data-testid="box-check-restored"
      >
        <MdiHistory class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 grow">{{ $t("box_check.restored") }}</span>
        <Button size="sm" variant="outline" class="shrink-0" data-testid="box-check-start-over" @click="startOver">
          {{ $t("box_check.start_over") }}
        </Button>
      </div>

      <Card v-if="total === 0 && lent.length === 0" class="p-6 text-center text-muted-foreground">
        {{ $t("box_check.empty") }}
      </Card>
      <Card v-else class="divide-y overflow-hidden">
        <div
          v-for="item in items"
          :key="item.id"
          class="flex flex-wrap items-center gap-2 pb-2 pr-3 sm:flex-nowrap sm:pb-0"
          data-testid="box-check-row"
        >
          <ItemListRow :item="item" hide-path class="min-w-0 grow basis-full sm:basis-auto" />
          <div class="ml-3 flex gap-2 sm:ml-0">
            <Button
              size="sm"
              :variant="verdicts[item.id] === 'present' ? 'default' : 'outline'"
              data-testid="box-check-present"
              @click="set(item.id, 'present')"
            >
              <MdiCheck />
              {{ $t("box_check.present") }}
            </Button>
            <Button
              size="sm"
              :variant="verdicts[item.id] === 'missing' ? 'destructive' : 'outline'"
              data-testid="box-check-missing"
              @click="set(item.id, 'missing')"
            >
              <MdiClose />
              {{ $t("box_check.missing") }}
            </Button>
            <Button size="sm" variant="outline" data-testid="box-check-elsewhere" @click="elsewhere(item)">
              <MdiFolderMoveOutline />
              {{ $t("box_check.elsewhere") }}
            </Button>
          </div>
        </div>
        <div
          v-for="(m, id) in moved"
          :key="id"
          class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          data-testid="box-check-moved-row"
        >
          <MdiFolderMoveOutline class="size-4 shrink-0" />
          <NuxtLink :to="`/item/${id}`" class="truncate hover:underline">{{ m.name }}</NuxtLink>
          <MdiArrowRight class="size-4 shrink-0" />
          <span class="truncate">{{ m.to.name }}</span>
          <span class="ml-auto shrink-0 text-xs">{{ $t("box_check.moved") }}</span>
        </div>
        <div
          v-for="item in lent"
          :key="item.id"
          class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          data-testid="box-check-lent-row"
        >
          <MdiHandExtended class="size-4 shrink-0 text-amber-600" />
          <NuxtLink :to="`/item/${item.id}`" class="truncate hover:underline">{{ item.name }}</NuxtLink>
          <span class="ml-auto shrink-0 text-xs">{{ $t("items.lending.badge_to", { name: item.lentTo }) }}</span>
        </div>
      </Card>

      <div class="flex gap-2">
        <Button v-if="items.length" variant="outline" class="flex-1" @click="allPresent">
          {{ $t("box_check.rest_present") }}
        </Button>
        <Button
          class="flex-[2]"
          :disabled="saving || items.some(i => !verdicts[i.id])"
          data-testid="box-check-finish"
          @click="finish"
        >
          {{ $t("box_check.finish") }}
        </Button>
      </div>
    </template>
  </div>
</template>
