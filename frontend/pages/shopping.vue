<script setup lang="ts">
  // Fork: shopping list. Everything tagged "Nachkaufen", ticked off with
  // "Gekauft" while shopping; shareable as plain text.
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCartOutline from "~icons/mdi/cart-outline";
  import MdiCartCheck from "~icons/mdi/cart-check";
  import MdiCartPlus from "~icons/mdi/cart-plus";
  import MdiClose from "~icons/mdi/close";
  import MdiShareVariant from "~icons/mdi/share-variant";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Input } from "@/components/ui/input";
  import BaseContainer from "@/components/Base/Container.vue";
  import { useTagStore } from "~/stores/tags";

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("restock.title") });

  const api = useUserApi();
  const tagStore = useTagStore();
  const restock = useRestock();

  const { data, refresh, pending } = useAsyncData("restock-page", async () => {
    await tagStore.ensureAllTagsFetched();
    const id = restock.tag.value?.id;
    if (!id) return [] as EntitySummary[];
    const { data, error } = await api.items.getAll({ tags: [id], page: -1, pageSize: -1, orderBy: "name" });
    if (error) return [] as EntitySummary[];
    return data.items;
  });
  const items = computed(() => data.value ?? []);

  const busy = ref<string | null>(null);
  async function run(e: EntitySummary, fn: (e: EntitySummary) => Promise<boolean>) {
    busy.value = e.id;
    try {
      if (await fn(e)) await refresh();
    } finally {
      busy.value = null;
    }
  }

  async function share() {
    const text = [t("restock.title") + ":", ...items.value.map(e => "• " + e.name)].join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("restock.toast.copied"));
    } catch {
      toast.error(t("restock.toast.failed"));
    }
  }

  // "Put something on the list": search items that are not on it yet.
  const query = ref("");
  const results = ref<EntitySummary[]>([]);
  let searchSeq = 0;
  watchDebounced(
    query,
    async q => {
      const seq = ++searchSeq;
      if (q.trim().length < 2) {
        results.value = [];
        return;
      }
      const { data, error } = await api.items.getAll({ q: q.trim(), pageSize: 20 });
      if (error || seq !== searchSeq) return;
      results.value = data.items.filter(e => !e.entityType?.isLocation && !restock.onList(e)).slice(0, 8);
    },
    { debounce: 250 }
  );

  async function addFromSearch(e: EntitySummary) {
    query.value = "";
    results.value = [];
    if (await restock.add(e)) await refresh();
  }
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header class="flex items-start gap-2">
      <div class="grow">
        <h1 class="text-2xl font-semibold">{{ $t("restock.title") }}</h1>
        <p class="text-sm text-muted-foreground">{{ $t("restock.intro") }}</p>
      </div>
      <Button
        v-if="items.length"
        variant="outline"
        size="sm"
        class="shrink-0"
        data-testid="restock-share"
        @click="share"
      >
        <MdiShareVariant class="mr-1" />
        {{ $t("restock.share") }}
      </Button>
    </header>

    <Card class="flex flex-col gap-2 p-3">
      <label class="flex items-center gap-2 font-medium" for="restock-search">
        <MdiCartPlus class="size-5" />
        {{ $t("restock.add_something") }}
      </label>
      <Input
        id="restock-search"
        v-model="query"
        type="search"
        :placeholder="$t('restock.search_item')"
        data-testid="restock-search"
      />
      <ul v-if="results.length > 0" class="divide-y rounded-xl border">
        <li v-for="r in results" :key="r.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 p-2 text-left hover:bg-accent"
            data-testid="restock-search-result"
            @click="addFromSearch(r)"
          >
            <span class="min-w-0 grow truncate">{{ r.name }}</span>
            <span v-if="r.parent" class="truncate text-sm text-muted-foreground">{{ r.parent.name }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query.trim().length >= 2" class="text-sm text-muted-foreground">
        {{ $t("restock.no_results") }}
      </p>
    </Card>

    <p v-if="pending && !data" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card
      v-else-if="items.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="restock-none"
    >
      <MdiCartOutline class="size-12 text-muted-foreground" />
      <p class="text-lg font-medium">{{ $t("restock.none") }}</p>
      <p class="text-sm text-muted-foreground">{{ $t("restock.none_hint") }}</p>
    </Card>

    <Card v-else class="divide-y overflow-hidden">
      <div v-for="e in items" :key="e.id" class="flex items-center gap-3 p-3" data-testid="restock-row">
        <MdiCartOutline class="size-5 shrink-0 text-amber-600" />
        <div class="min-w-0 grow">
          <NuxtLink :to="`/item/${e.id}`" class="font-medium hover:underline">{{ e.name }}</NuxtLink>
          <div v-if="e.parent" class="truncate text-sm text-muted-foreground">
            {{ $t("restock.belongs_in") }}
            <NuxtLink :to="`/location/${e.parent.id}`" class="hover:underline">{{ e.parent.name }}</NuxtLink>
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          class="shrink-0"
          :disabled="busy === e.id"
          :aria-label="$t('restock.remove')"
          :title="$t('restock.remove')"
          data-testid="restock-remove"
          @click="run(e, x => restock.remove(x))"
        >
          <MdiClose />
        </Button>
        <Button
          size="sm"
          class="shrink-0"
          :disabled="busy === e.id"
          data-testid="restock-bought"
          @click="run(e, restock.bought)"
        >
          <MdiCartCheck class="mr-1" />
          {{ $t("restock.bought") }}
        </Button>
      </div>
    </Card>
  </BaseContainer>
</template>
