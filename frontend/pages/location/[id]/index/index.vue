<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { AnyDetail, Details } from "~~/components/global/DetailsSection/types";
  import { filterZeroValues } from "~~/components/global/DetailsSection/types";
  import type { ItemAttachment } from "~~/lib/api/types/data-contracts";
  import MdiPackageVariant from "~icons/mdi/package-variant";
  import MdiChevronDown from "~icons/mdi/chevron-down";
  import MdiArrowDown from "~icons/mdi/arrow-down";
  import MdiPlus from "~icons/mdi/plus";
  import MdiPencil from "~icons/mdi/pencil";
  import MdiDelete from "~icons/mdi/delete";
  import MdiDotsVertical from "~icons/mdi/dots-vertical";
  import MdiArrowDownBold from "~icons/mdi/arrow-down-bold";
  import MdiStar from "~icons/mdi/star";
  import MdiStarOutline from "~icons/mdi/star-outline";
  import MdiClipboardCheckOutline from "~icons/mdi/clipboard-check-outline";
  import LocationCollectDialog from "~/components/Location/CollectDialog.vue";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "@/components/ui/dropdown-menu";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { Card } from "@/components/ui/card";
  import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbSeparator,
  } from "@/components/ui/breadcrumb";
  import { Button } from "@/components/ui/button";
  import { Badge } from "@/components/ui/badge";
  import { Separator } from "@/components/ui/separator";
  import { DialogID } from "~/components/ui/dialog-provider/utils";
  import BaseCard from "@/components/Base/Card.vue";
  import Currency from "~/components/global/Currency.vue";
  import DateTime from "~/components/global/DateTime.vue";
  import LabelMaker from "~/components/global/LabelMaker.vue";
  import Markdown from "~/components/global/Markdown.vue";
  import DetailsSection from "~/components/global/DetailsSection/DetailsSection.vue";
  import BaseSectionHeader from "@/components/Base/SectionHeader.vue";
  import ItemViewSelectable from "~/components/Item/View/Selectable.vue";
  import ItemAttachmentsList from "~/components/Item/AttachmentsList.vue";
  import ItemImageDialog from "~/components/Item/ImageDialog.vue";
  import LocationCard from "~/components/Location/Card.vue";
  import TagChip from "~/components/Tag/Chip.vue";

  definePageMeta({
    middleware: ["auth"],
  });

  const { t } = useI18n();

  const { openDialog } = useDialog();

  const route = useRoute();
  const api = useUserApi();

  const locationId = computed<string>(() => route.params.id as string);

  const places = usePlaces();
  const collectOpen = ref(false);
  const pinned = computed(() => places.isPinned(locationId.value));
  const togglePin = () => places.togglePin(locationId.value);
  // Remember the box for "recently used" on the home page and in the box picker.
  watch(locationId, id => id && places.visit(id), { immediate: true });

  // Phone: text only, so "Hierher räumen" fits; icons from sm up.
  const boxActionClass =
    "min-w-0 gap-1 px-1 text-xs min-[375px]:text-[13px] sm:gap-2 sm:px-4 sm:text-sm [&_svg]:hidden [&_svg]:size-4 sm:[&_svg]:inline-block";

  const collectTarget = computed(() => ({ id: locationId.value, name: location.value?.name ?? "" }));

  const { data: location } = useAsyncData(locationId.value, async () => {
    const { data, error } = await api.items.getLocation(locationId.value);
    if (error) {
      toast.error(t("locations.toast.failed_load_location"));
      navigateTo("/home");
      return;
    }

    return data;
  });

  const confirm = useConfirm();

  async function confirmDelete() {
    const { isCanceled } = await confirm.open(t("locations.location_items_delete_confirm"));
    if (isCanceled) {
      return;
    }

    const { error } = await api.items.deleteLocation(locationId.value);
    if (error) {
      toast.error(t("locations.toast.failed_delete_location"));
      return;
    }

    toast.success(t("locations.toast.location_deleted"));
    navigateTo("/locations");
  }

  function openCreateItem() {
    openDialog(DialogID.CreateEntity, {
      params: {
        baseType: "item",
      },
    });
  }

  function goToEdit() {
    navigateTo(`/location/${locationId.value}/edit`);
  }

  // Photos
  type Photo = {
    thumbnailSrc?: string;
    originalSrc: string;
    attachmentId: string;
    originalType?: string;
  };

  const photos = computed<Photo[]>(() => {
    if (!location.value?.attachments) {
      return [];
    }
    return location.value.attachments.reduce((acc, cur) => {
      if (cur.type === "photo") {
        const photo: Photo = {
          originalSrc: api.authURL(`/entities/${location.value!.id}/attachments/${cur.id}`),
          originalType: cur.mimeType,
          attachmentId: cur.id,
        };
        if (cur.thumbnail) {
          photo.thumbnailSrc = api.authURL(`/entities/${location.value!.id}/attachments/${cur.thumbnail.id}`);
        } else {
          photo.thumbnailSrc = photo.originalSrc;
        }
        acc.push(photo);
      }
      return acc;
    }, [] as Photo[]);
  });

  function openImageDialog(img: Photo, entityId: string) {
    openDialog(DialogID.ItemImage, {
      params: {
        type: "preloaded",
        originalSrc: img.originalSrc,
        originalType: img.originalType,
        thumbnailSrc: img.thumbnailSrc,
        attachmentId: img.attachmentId,
        itemId: entityId,
      },
      onClose: result => {
        if (result?.action === "delete") {
          location.value!.attachments = location.value!.attachments.filter(a => a.id !== result.id);
        }
      },
    });
  }

  // Attachments (non-photo)
  const nonPhotoAttachments = computed(() => {
    if (!location.value?.attachments) {
      return { attachments: [], warranty: [], manuals: [], receipts: [] };
    }
    return location.value.attachments.reduce(
      (acc, attachment) => {
        if (attachment.type === "photo") return acc;
        if (attachment.type === "warranty") acc.warranty.push(attachment);
        else if (attachment.type === "manual") acc.manuals.push(attachment);
        else if (attachment.type === "receipt") acc.receipts.push(attachment);
        else acc.attachments.push(attachment);
        return acc;
      },
      {
        attachments: [] as ItemAttachment[],
        warranty: [] as ItemAttachment[],
        manuals: [] as ItemAttachment[],
        receipts: [] as ItemAttachment[],
      }
    );
  });

  const hasNonPhotoAttachments = computed(() => {
    const a = nonPhotoAttachments.value;
    return a.attachments.length > 0 || a.warranty.length > 0 || a.manuals.length > 0 || a.receipts.length > 0;
  });

  // Details
  const locationDetails = computed<Details>(() => {
    if (!location.value) {
      return [];
    }

    const ret: Details = [
      {
        name: "items.notes",
        type: "markdown",
        text: location.value.notes,
      },
      // The box-check reminder's bookkeeping field is not meant for reading.
      ...(location.value.fields || [])
        .filter(field => field.name !== ACK_FIELD)
        .map(field => {
          return {
            name: field.name,
            text: field.textValue,
          } as AnyDetail;
        }),
    ];

    // No "show empty" switch on this page, so empty notes never take up space.
    return filterZeroValues(ret);
  });

  const hasChildren = computed(() => (location.value?.children?.length ?? 0) > 0);
  // Remembered per device; folded by default.
  const directItemsOpen = useLocalStorage("homebox/location/direct-items-open", false);

  async function showDirectItems() {
    directItemsOpen.value = true;
    await nextTick();
    document.getElementById("direct-items")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const { data: items, refresh: refreshItemList } = useAsyncData(
    () => locationId.value + "_item_list",
    async () => {
      if (!locationId.value) {
        return [];
      }

      const resp = await api.items.getAll({
        parentIds: [locationId.value],
      });

      if (resp.error) {
        toast.error(t("items.toast.failed_load_items"));
        return [];
      }

      return resp.data.items;
    },
    {
      watch: [locationId],
    }
  );
</script>

<template>
  <div>
    <ItemImageDialog />

    <div v-if="location">
      <!-- set page title -->
      <Title>{{ location.name }}</Title>

      <!-- Photo gallery -->
      <section v-if="photos.length > 0" class="mb-4">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          <button
            v-for="(photo, i) in photos"
            :key="i"
            class="group relative aspect-1 h-32 overflow-hidden rounded-lg border bg-muted"
            @click="openImageDialog(photo, location.id)"
          >
            <img
              :src="photo.thumbnailSrc || photo.originalSrc"
              :alt="location.name"
              class="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
          </button>
        </div>
      </section>

      <Card class="p-3">
        <header class="relative" :class="{ 'mb-2': location?.description }">
          <div class="flex flex-wrap items-end gap-2">
            <div
              class="mb-auto flex size-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
            >
              <MdiPackageVariant class="size-7" />
            </div>
            <div class="pr-10 sm:pr-0">
              <Breadcrumb v-if="location?.parent">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink as-child class="text-foreground/70 hover:underline">
                      <NuxtLink :to="`/location/${location.parent.id}`">
                        {{ location.parent.name }}
                      </NuxtLink>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem> {{ location.name }} </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <h1 class="flex items-center gap-3 pb-1 text-2xl">
                {{ location ? location.name : "" }}

                <Badge v-if="location && location.totalPrice" variant="secondary">
                  <Currency :amount="location.totalPrice" />
                </Badge>
              </h1>
              <div class="flex flex-wrap gap-1 text-xs">
                <div>
                  {{ $t("global.created") }}
                  <DateTime :date="location?.createdAt" />
                </div>
              </div>
              <div v-if="location.tags && location.tags.length > 0" class="mt-2 flex flex-wrap gap-1">
                <TagChip v-for="tag in location.tags" :key="tag.id" :tag="tag" size="sm" />
              </div>
            </div>
            <!-- Phone: labels and "+ Artikel" share one row, ⋯ sits top right. -->
            <div class="mt-2 flex flex-wrap items-center gap-2 sm:ml-auto">
              <LabelMaker :id="location.id" type="location" />
              <Button data-testid="location-create-item" class="px-3 sm:px-4" @click="openCreateItem">
                <MdiPlus name="mdi-plus" />
                <span class="sm:hidden">{{ $t("global.item") }}</span>
                <span class="hidden sm:inline">{{ $t("components.location.create_item") }}</span>
              </Button>
              <div class="absolute right-0 top-0 sm:static">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="icon" :aria-label="$t('global.more_actions')">
                      <MdiDotsVertical class="size-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-48">
                    <DropdownMenuItem @click="goToEdit">
                      <MdiPencil class="mr-2 size-4" />
                      {{ $t("global.edit") }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-destructive focus:text-destructive" @click="confirmDelete()">
                      <MdiDelete class="mr-2 size-4" />
                      {{ $t("global.delete") }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </header>
        <Separator v-if="location && location.description" />
        <Markdown v-if="location && location.description" class="mt-3 text-base" :source="location.description" />
      </Card>

      <!-- Quick actions for the box you just scanned -->
      <!-- One row on the phone: three equal, compact buttons. -->
      <div class="mt-3 grid grid-cols-3 gap-2 sm:flex" data-testid="box-actions">
        <Button variant="outline" :class="boxActionClass" data-testid="box-collect" @click="collectOpen = true">
          <MdiArrowDownBold />
          <span class="truncate">{{ $t("collect.button") }}</span>
        </Button>
        <Button variant="outline" :class="boxActionClass" data-testid="box-pin" @click="togglePin">
          <MdiStar v-if="pinned" class="text-amber-500" />
          <MdiStarOutline v-else />
          <span class="truncate">{{ pinned ? $t("places.pinned") : $t("places.pin") }}</span>
        </Button>
        <Button variant="outline" as-child :class="boxActionClass" data-testid="box-check">
          <NuxtLink :to="`/location/${locationId}/check`">
            <MdiClipboardCheckOutline />
            <span class="truncate">{{ $t("box_check.button") }}</span>
          </NuxtLink>
        </Button>
      </div>
      <LocationCollectDialog v-model:open="collectOpen" :box="collectTarget" @moved="refreshItemList" />

      <!-- Fork: the folded direct items sit below a long sub-location list; point to them. -->
      <button
        v-if="hasChildren && items && items.length > 0"
        type="button"
        class="mt-3 flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
        data-testid="jump-direct-items"
        @click="showDirectItems"
      >
        {{ $t("locations.direct_items_hint", { count: items.length }) }}
        <MdiArrowDown class="size-4" />
      </button>

      <!-- Details (notes, custom fields) -->
      <BaseCard v-if="locationDetails.length > 0" class="mt-4">
        <template #title> {{ $t("global.details") }} </template>
        <DetailsSection :details="locationDetails" />
      </BaseCard>

      <!-- Attachments (non-photo) -->
      <BaseCard v-if="hasNonPhotoAttachments" class="mt-4">
        <template #title> {{ $t("items.attachments") }} </template>
        <div class="border-t px-4 py-2">
          <ItemAttachmentsList
            v-if="nonPhotoAttachments.attachments.length > 0"
            :attachments="nonPhotoAttachments.attachments"
            :item-id="location.id"
          />
          <ItemAttachmentsList
            v-if="nonPhotoAttachments.warranty.length > 0"
            :attachments="nonPhotoAttachments.warranty"
            :item-id="location.id"
          />
          <ItemAttachmentsList
            v-if="nonPhotoAttachments.manuals.length > 0"
            :attachments="nonPhotoAttachments.manuals"
            :item-id="location.id"
          />
          <ItemAttachmentsList
            v-if="nonPhotoAttachments.receipts.length > 0"
            :attachments="nonPhotoAttachments.receipts"
            :item-id="location.id"
          />
        </div>
      </BaseCard>

      <!-- Items in this location (plain boxes: as before) -->
      <section v-if="location && items && !hasChildren">
        <ItemViewSelectable :items="items" @refresh="refreshItemList" />
      </section>

      <!-- Child locations -->
      <section v-if="location && hasChildren" class="mt-6">
        <BaseSectionHeader class="mb-5"> {{ $t("locations.child_locations") }} </BaseSectionHeader>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <LocationCard v-for="child in location.children" :key="child.id" :location="child" />
        </div>
      </section>

      <!-- Fork: places with sub-locations (Keller, Wohnung) list their own items below the
           sub-locations, folded away; nothing at all when there are none. -->
      <section v-if="location && hasChildren && items && items.length > 0" id="direct-items" class="mt-6">
        <button
          type="button"
          class="flex items-center gap-1 text-lg font-semibold"
          :aria-expanded="directItemsOpen"
          data-testid="toggle-direct-items"
          @click="directItemsOpen = !directItemsOpen"
        >
          {{ $t("locations.direct_items", { name: location.name }) }}
          <Badge variant="secondary">{{ items.length }}</Badge>
          <MdiChevronDown class="size-5 transition-transform" :class="{ '-rotate-90': !directItemsOpen }" />
        </button>
        <ItemViewSelectable v-if="directItemsOpen" :items="items" @refresh="refreshItemList" />
      </section>
    </div>
  </div>
</template>
