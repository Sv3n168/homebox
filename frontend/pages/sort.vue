<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiInboxArrowDown from "~icons/mdi/inbox-arrow-down";
  import MdiFolderMoveOutline from "~icons/mdi/folder-move-outline";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import BaseContainer from "@/components/Base/Container.vue";
  import ItemListRow from "~/components/Item/ListRow.vue";

  // Sorting mode: everything in "Unsortiert", one tap (scan or search) per item
  // to put it into its real box.

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("sort.title") });

  const api = useUserApi();
  const { inbox, create } = useInbox();
  const { pick } = useBoxPicker();
  const { move } = useMove();

  const items = ref<EntitySummary[]>([]);
  const loading = ref(true);
  const creating = ref(false);

  async function load() {
    const box = inbox.value;
    if (!box) {
      items.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    const { data, error } = await api.items.getAll({ parentIds: [box.id], page: -1, pageSize: -1, orderBy: "name" });
    loading.value = false;
    if (error) {
      toast.error(t("sort.toast.load_failed"));
      return;
    }
    items.value = data.items.filter(i => !i.entityType?.isLocation);
  }

  watch(() => inbox.value?.id, load, { immediate: true });

  async function createInbox() {
    creating.value = true;
    const box = await create();
    creating.value = false;
    if (!box) toast.error(t("sort.toast.create_failed"));
  }

  async function sortItem(item: EntitySummary) {
    const box = await pick({
      title: t("move.title", { name: item.name }),
      exclude: inbox.value ? [inbox.value.id] : [],
    });
    if (box && (await move([item], box)) > 0) {
      items.value = items.value.filter(i => i.id !== item.id);
    }
  }
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header>
      <h1 class="text-2xl font-semibold">{{ $t("sort.title") }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("sort.intro") }}</p>
    </header>

    <Card v-if="!inbox" class="flex flex-col items-center gap-3 p-8 text-center" data-testid="sort-no-inbox">
      <MdiInboxArrowDown class="size-12 text-muted-foreground" />
      <p>{{ $t("sort.no_inbox") }}</p>
      <Button :disabled="creating" data-testid="sort-create-inbox" @click="createInbox">
        {{ $t("sort.create_inbox") }}
      </Button>
    </Card>

    <p v-else-if="loading" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card
      v-else-if="items.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="sort-done"
    >
      <MdiCheckCircle class="size-12 text-primary" />
      <p class="text-lg font-medium">{{ $t("sort.all_done") }}</p>
    </Card>

    <Card v-else class="divide-y overflow-hidden">
      <div v-for="item in items" :key="item.id" class="flex items-center pr-3" data-testid="sort-row">
        <ItemListRow :item="item" hide-path class="min-w-0 grow" />
        <Button
          size="sm"
          class="shrink-0"
          :aria-label="$t('sort.into_box')"
          data-testid="sort-into"
          @click="sortItem(item)"
        >
          <MdiFolderMoveOutline />
          <span class="hidden sm:inline">{{ $t("sort.into_box") }}</span>
        </Button>
      </div>
    </Card>
  </BaseContainer>
</template>
