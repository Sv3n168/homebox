<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntityFieldData, EntitySummary } from "~~/lib/api/types/data-contracts";
  import { entityToUpdate } from "~~/lib/cleanup/duplicates";
  import MdiCheck from "~icons/mdi/check";
  import MdiClose from "~icons/mdi/close";
  import MdiFolderMoveOutline from "~icons/mdi/folder-move-outline";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Progress } from "@/components/ui/progress";
  import ItemListRow from "~/components/Item/ListRow.vue";

  // Mini inventory of one box: tick off what is there, flag what is missing
  // (tag "Vermisst"), move what belongs elsewhere. Stored in Homebox itself.

  definePageMeta({ middleware: ["auth"] });

  type Verdict = "present" | "missing" | "moved";

  const { t } = useI18n();
  const route = useRoute();
  const api = useUserApi();
  const { pick } = useBoxPicker();
  const { move } = useMove();
  const missingTag = useMissingTag();

  const boxId = computed(() => route.params.id as string);
  const boxName = ref("");
  const items = ref<EntitySummary[]>([]);
  const verdicts = ref<Record<string, Verdict>>({});
  const loading = ref(true);
  const saving = ref(false);
  const finished = ref(false);

  useHead({ title: () => "HomeBox | " + t("box_check.title", { name: boxName.value }) });

  const checked = computed(() => items.value.filter(i => verdicts.value[i.id]).length);
  const progress = computed(() => (items.value.length ? Math.round((checked.value / items.value.length) * 100) : 100));
  const missingCount = computed(() => Object.values(verdicts.value).filter(v => v === "missing").length);

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
    items.value = list.data.items.filter(i => !i.entityType?.isLocation);
  }

  function set(id: string, v: Verdict) {
    verdicts.value = { ...verdicts.value, [id]: v };
  }

  async function elsewhere(item: EntitySummary) {
    const box = await pick({ title: t("move.title", { name: item.name }), exclude: [boxId.value] });
    if (box && (await move([item], box)) > 0) set(item.id, "moved");
  }

  function allPresent() {
    for (const i of items.value) if (!verdicts.value[i.id]) set(i.id, "present");
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

  async function stampBox(): Promise<boolean> {
    const { data, error } = await api.items.getLocation(boxId.value);
    if (error) return false;
    const update = entityToUpdate(data);
    const today = new Date().toISOString().slice(0, 10);
    const fields = [...(update.fields ?? [])];
    const existing = fields.find(f => f.name === CHECKED_FIELD);
    if (existing) {
      existing.type = "text";
      existing.textValue = today;
    } else {
      fields.push({
        id: null,
        name: CHECKED_FIELD,
        type: "text",
        textValue: today,
        numberValue: 0,
        booleanValue: false,
      } as unknown as EntityFieldData);
    }
    update.fields = fields;
    const res = await api.items.update(boxId.value, update);
    return !res.error;
  }

  async function finish() {
    saving.value = true;
    const failed = await saveTags();
    const stamped = await stampBox();
    saving.value = false;
    if (failed !== 0 || !stamped) {
      toast.error(t("box_check.toast.save_failed"));
      return;
    }
    finished.value = true;
    toast.success(t("box_check.toast.saved"));
  }

  onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <header class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">{{ $t("box_check.title", { name: boxName }) }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("box_check.intro") }}</p>
      <template v-if="!loading && items.length">
        <Progress :model-value="progress" />
        <p class="text-sm text-muted-foreground" data-testid="box-check-progress">
          {{ $t("box_check.progress", { done: checked, total: items.length }) }}
        </p>
      </template>
    </header>

    <p v-if="loading" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card v-else-if="finished" class="flex flex-col items-center gap-3 p-8 text-center" data-testid="box-check-done">
      <MdiCheckCircle class="size-12 text-primary" />
      <p class="text-lg font-medium">{{ $t("box_check.done", { missing: missingCount }) }}</p>
      <Button as-child variant="outline">
        <NuxtLink :to="`/location/${boxId}`">{{ $t("box_check.back") }}</NuxtLink>
      </Button>
    </Card>

    <template v-else>
      <Card v-if="items.length === 0" class="p-6 text-center text-muted-foreground">{{ $t("box_check.empty") }}</Card>
      <Card v-else class="divide-y overflow-hidden">
        <div
          v-for="item in items"
          :key="item.id"
          class="flex flex-wrap items-center gap-2 pb-2 pr-3 sm:flex-nowrap sm:pb-0"
          :class="{ 'opacity-50': verdicts[item.id] === 'moved' }"
          data-testid="box-check-row"
        >
          <ItemListRow :item="item" class="min-w-0 grow basis-full sm:basis-auto" />
          <div class="ml-3 flex gap-2 sm:ml-0">
            <Button
              size="sm"
              :variant="verdicts[item.id] === 'present' ? 'default' : 'outline'"
              :disabled="verdicts[item.id] === 'moved'"
              data-testid="box-check-present"
              @click="set(item.id, 'present')"
            >
              <MdiCheck />
              {{ $t("box_check.present") }}
            </Button>
            <Button
              size="sm"
              :variant="verdicts[item.id] === 'missing' ? 'destructive' : 'outline'"
              :disabled="verdicts[item.id] === 'moved'"
              data-testid="box-check-missing"
              @click="set(item.id, 'missing')"
            >
              <MdiClose />
              {{ $t("box_check.missing") }}
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="verdicts[item.id] === 'moved'"
              data-testid="box-check-elsewhere"
              @click="elsewhere(item)"
            >
              <MdiFolderMoveOutline />
              {{ verdicts[item.id] === "moved" ? $t("box_check.moved") : $t("box_check.elsewhere") }}
            </Button>
          </div>
        </div>
      </Card>

      <div class="flex gap-2">
        <Button v-if="items.length" variant="outline" class="flex-1" @click="allPresent">
          {{ $t("box_check.rest_present") }}
        </Button>
        <Button
          class="flex-[2]"
          :disabled="saving || checked < items.length"
          data-testid="box-check-finish"
          @click="finish"
        >
          {{ $t("box_check.finish") }}
        </Button>
      </div>
    </template>
  </div>
</template>
