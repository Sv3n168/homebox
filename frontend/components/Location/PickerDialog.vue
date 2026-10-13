<template>
  <DialogRoot :open="state.open" @update:open="open => !open && finish(null)">
    <DialogContent class="flex max-h-[85dvh] flex-col gap-3">
      <DialogHeader data-testid="box-picker">
        <DialogTitle>{{ state.title || $t("box_picker.title") }}</DialogTitle>
      </DialogHeader>

      <template v-if="state.scanning">
        <AppQrVideo @result="onScan" />
        <Button variant="outline" @click="state.scanning = false">{{ $t("box_picker.search_instead") }}</Button>
      </template>

      <template v-else>
        <div class="flex gap-2">
          <Input
            v-model="search"
            :placeholder="$t('box_picker.search')"
            type="search"
            class="grow"
            data-testid="box-picker-search"
          />
          <Button :aria-label="$t('box_picker.scan')" @click="state.scanning = true">
            <MdiQrcodeScan />
            <span class="hidden sm:inline">{{ $t("box_picker.scan") }}</span>
          </Button>
        </div>

        <div class="-mx-2 min-h-0 flex-1 overflow-y-auto">
          <p
            v-if="!search && favorites.length > 0"
            class="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground"
          >
            {{ $t("box_picker.favorites") }}
          </p>
          <button
            v-for="box in shown"
            :key="box.id"
            type="button"
            class="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-accent"
            data-testid="box-picker-option"
            @click="finish(box)"
          >
            <MdiStar v-if="places.isPinned(box.id)" class="size-5 shrink-0 text-amber-500" />
            <MdiArchiveOutline v-else class="size-5 shrink-0 text-muted-foreground" />
            <span class="min-w-0">
              <span class="block truncate font-medium">{{ box.name }}</span>
              <span v-if="box.treeString !== box.name" class="block truncate text-xs text-muted-foreground">
                {{ box.treeString.replaceAll(" > ", " › ") }}
              </span>
            </span>
          </button>
          <p v-if="shown.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">
            {{ $t("box_picker.none") }}
          </p>
        </div>
      </template>
    </DialogContent>
  </DialogRoot>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import fuzzysort from "fuzzysort";
  import { DialogRoot } from "reka-ui";
  import MdiQrcodeScan from "~icons/mdi/qrcode-scan";
  import MdiStar from "~icons/mdi/star";
  import MdiArchiveOutline from "~icons/mdi/archive-outline";
  import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";
  import { toast } from "@/components/ui/sonner";
  import AppQrVideo from "~/components/App/QrVideo.vue";
  import { parseLabel } from "~/lib/places/resolve";
  import type { PickedBox } from "~/composables/use-box-picker";

  const { t } = useI18n();
  const api = useUserApi();
  const { state, finish } = useBoxPicker();
  const places = usePlaces();
  const boxes = useFlatLocations();
  const search = ref("");

  watch(
    () => state.open,
    open => {
      if (open) search.value = "";
    }
  );

  const candidates = computed(() => boxes.value.filter(b => !state.exclude.includes(b.id)));

  const favorites = computed(() =>
    places.favorites.value.map(id => candidates.value.find(b => b.id === id)).filter((b): b is PickedBox => !!b)
  );

  const shown = computed<PickedBox[]>(() => {
    if (!search.value) {
      const rest = candidates.value.filter(b => !places.favorites.value.includes(b.id));
      return [...favorites.value, ...rest];
    }
    return fuzzysort.go(search.value, candidates.value, { keys: ["name", "treeString"] }).map(r => r.obj);
  });

  let busy = false;
  async function onScan(text: string) {
    if (busy) return;
    const label = parseLabel(text, window.location.origin);
    if (!label) {
      toast.error(t("box_picker.not_a_label"));
      return;
    }
    busy = true;
    try {
      let id: string | undefined;
      if (label.kind === "entity") {
        id = label.id;
      } else {
        const { data } = await api.assets.get(label.assetId);
        id = data?.items?.[0]?.id;
      }
      const box = id ? boxes.value.find(b => b.id === id) : undefined;
      if (!box) {
        toast.error(t("box_picker.not_a_box"));
        return;
      }
      if (state.exclude.includes(box.id)) {
        toast.info(t("box_picker.same_box"));
        return;
      }
      finish(box);
    } finally {
      busy = false;
    }
  }
</script>
