<template>
  <Dialog :dialog-id="DialogID.LendItem">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t("items.lending.lend_title", { name: item.name }) }}</DialogTitle>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="save">
        <FormTextField v-model="lentTo" :label="$t('items.lending.lent_to')" :max-length="255" required />
        <FormDatePicker v-model="lentDate" :label="$t('items.lending.lent_date')" />
        <FormDatePicker v-model="lentReturnDate" :label="$t('items.lending.return_date')" />
        <DialogFooter>
          <Button type="submit" :disabled="saving || lentTo.trim() === ''">
            {{ $t("items.lending.lend") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
  import type { EntityOut } from "~~/lib/api/types/data-contracts";
  import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { DialogID } from "~/components/ui/dialog-provider/utils";
  import FormTextField from "~/components/Form/TextField.vue";
  import FormDatePicker from "~/components/Form/DatePicker.vue";
  import { useLending } from "~/composables/use-lending";
  import { toDateOnlyString } from "~/lib/datelib/dateOnly";

  const props = defineProps<{ item: EntityOut }>();
  const emit = defineEmits<{ saved: [] }>();

  const { closeDialog, activeDialog } = useDialog();
  const { lend } = useLending();

  const lentTo = ref("");
  const lentDate = ref<string | Date | null>(null);
  const lentReturnDate = ref<string | Date | null>(null);
  const saving = ref(false);

  // Prefill on open: the current loan when editing it, otherwise "since today".
  watch(
    () => activeDialog.value === DialogID.LendItem,
    open => {
      if (!open) return;
      lentTo.value = props.item.lentTo ?? "";
      lentDate.value = toDateOnlyString(props.item.lentDate) || toDateOnlyString(new Date());
      lentReturnDate.value = toDateOnlyString(props.item.lentReturnDate);
    }
  );

  async function save() {
    saving.value = true;
    const ok = await lend(props.item.id, {
      lentTo: lentTo.value,
      lentDate: toDateOnlyString(lentDate.value),
      lentReturnDate: toDateOnlyString(lentReturnDate.value),
    });
    saving.value = false;
    if (ok) {
      closeDialog(DialogID.LendItem);
      emit("saved");
    }
  }
</script>
