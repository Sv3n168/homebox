<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiTagPlusOutline from "~icons/mdi/tag-plus-outline";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiSkipNext from "~icons/mdi/skip-next";
  import MdiPackageVariantClosed from "~icons/mdi/package-variant-closed";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Input } from "@/components/ui/input";
  import { Progress } from "@/components/ui/progress";
  import BaseContainer from "@/components/Base/Container.vue";
  import { useTagStore } from "~/stores/tags";

  // Walks through every item without a tag, one at a time: tap tags, save, next.

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("tag_assistant.title") });

  const api = useUserApi();
  const tagStore = useTagStore();
  const flatLocations = useFlatLocations();

  const queue = ref<EntitySummary[]>([]);
  const startTotal = ref(0);
  const done = ref(0);
  const loading = ref(true);
  const saving = ref(false);
  const selected = ref<string[]>([]);
  const newTag = ref("");

  // Tags used in this session float to the top: usually the next item needs them too.
  const usage = ref<Record<string, number>>({});
  const sortedTags = computed(() =>
    [...tagStore.tags].sort(
      (a, b) => (usage.value[b.id] ?? 0) - (usage.value[a.id] ?? 0) || a.name.localeCompare(b.name)
    )
  );

  const current = computed(() => queue.value[0] ?? null);
  const progress = computed(() => (startTotal.value > 0 ? Math.round((done.value / startTotal.value) * 100) : 100));
  const thumbUrl = computed(() => {
    const c = current.value;
    const id = c?.thumbnailId || c?.imageId;
    return c && id ? api.authURL(`/entities/${c.id}/attachments/${id}`) : null;
  });
  const path = computed(() => {
    const id = current.value?.parent?.id;
    return id ? (flatLocations.value.find(l => l.id === id)?.treeString ?? current.value?.parent?.name ?? "") : "";
  });

  async function load() {
    loading.value = true;
    await tagStore.ensureAllTagsFetched();
    const { data, error } = await api.items.getAll({ onlyWithoutTags: true, page: -1, pageSize: -1, orderBy: "name" });
    loading.value = false;
    if (error) {
      toast.error(t("tag_assistant.toast.load_failed"));
      return;
    }
    queue.value = data.items;
    startTotal.value = data.items.length;
    done.value = 0;
  }

  function toggle(id: string) {
    selected.value = selected.value.includes(id) ? selected.value.filter(x => x !== id) : [...selected.value, id];
  }

  async function addTag() {
    const name = newTag.value.trim();
    if (!name) return;
    const existing = tagStore.tags.find(tg => tg.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!selected.value.includes(existing.id)) selected.value.push(existing.id);
      newTag.value = "";
      return;
    }
    const { data, error } = await api.tags.create({ name, description: "", color: "", icon: "" });
    if (error) {
      toast.error(t("tag_assistant.toast.create_failed"));
      return;
    }
    await tagStore.refresh();
    selected.value.push(data.id);
    newTag.value = "";
  }

  async function saveAndNext() {
    const item = current.value;
    if (!item || selected.value.length === 0) return;
    saving.value = true;
    const { error } = await api.items.patch(item.id, { id: item.id, tagIds: selected.value });
    saving.value = false;
    if (error) {
      toast.error(t("tag_assistant.toast.save_failed"));
      return;
    }
    for (const id of selected.value) usage.value[id] = (usage.value[id] ?? 0) + 1;
    next();
  }

  function next() {
    queue.value = queue.value.slice(1);
    done.value++;
    selected.value = [];
    newTag.value = "";
  }

  onMounted(load);
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">{{ $t("tag_assistant.title") }}</h1>
      <template v-if="!loading && startTotal > 0">
        <Progress :model-value="progress" />
        <p class="text-sm text-muted-foreground" data-testid="tag-assistant-remaining">
          {{ $t("tag_assistant.remaining", { count: queue.length, total: startTotal }) }}
        </p>
      </template>
    </header>

    <p v-if="loading" class="text-muted-foreground">{{ $t("tag_assistant.loading") }}</p>

    <Card
      v-else-if="!current"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="tag-assistant-done"
    >
      <MdiCheckCircle class="size-12 text-primary" />
      <p class="text-lg font-medium">{{ $t("tag_assistant.all_done") }}</p>
      <Button as-child variant="outline">
        <NuxtLink to="/home">{{ $t("menu.home") }}</NuxtLink>
      </Button>
    </Card>

    <template v-else>
      <Card class="flex items-center gap-4 p-4" data-testid="tag-assistant-item">
        <div class="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted">
          <img v-if="thumbUrl" :src="thumbUrl" :alt="current.name" class="size-full object-cover" />
          <MdiPackageVariantClosed v-else class="size-9 text-muted-foreground" />
        </div>
        <div class="min-w-0">
          <NuxtLink :to="`/item/${current.id}`" class="text-xl font-semibold hover:underline">{{
            current.name
          }}</NuxtLink>
          <p v-if="path" class="truncate text-sm text-muted-foreground">{{ path }}</p>
          <p v-if="current.description" class="line-clamp-2 text-sm">{{ current.description }}</p>
        </div>
      </Card>

      <section class="flex flex-wrap gap-2" data-testid="tag-assistant-tags">
        <button
          v-for="tag in sortedTags"
          :key="tag.id"
          type="button"
          class="rounded-full border px-3 py-1.5 text-sm transition-colors"
          :class="selected.includes(tag.id) ? 'border-primary bg-primary text-primary-foreground' : 'bg-card'"
          @click="toggle(tag.id)"
        >
          {{ tag.name }}
        </button>
      </section>

      <form class="flex gap-2" @submit.prevent="addTag">
        <Input v-model="newTag" :placeholder="$t('tag_assistant.new_tag')" class="grow" />
        <Button type="submit" variant="outline" :disabled="!newTag.trim()">
          <MdiTagPlusOutline />
          {{ $t("tag_assistant.add") }}
        </Button>
      </form>

      <div class="flex gap-2">
        <Button variant="outline" class="flex-1" @click="next">
          <MdiSkipNext />
          {{ $t("tag_assistant.skip") }}
        </Button>
        <Button
          class="flex-[2]"
          :disabled="selected.length === 0 || saving"
          data-testid="tag-assistant-save"
          @click="saveAndNext"
        >
          {{ $t("tag_assistant.save_next") }}
        </Button>
      </div>
    </template>
  </BaseContainer>
</template>
