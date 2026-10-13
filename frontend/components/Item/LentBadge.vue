<template>
  <Badge
    v-if="lent"
    class="gap-1 text-wrap border-transparent"
    :class="
      overdue
        ? 'bg-destructive text-destructive-foreground hover:bg-destructive/80'
        : 'bg-amber-500 text-white hover:bg-amber-500/80 dark:bg-amber-600'
    "
    :title="tooltip"
  >
    <MdiHandExtended class="size-3.5 shrink-0" />
    <span v-if="compact">{{ overdue ? $t("items.lending.overdue") : $t("items.lending.badge") }}</span>
    <span v-else>
      {{ $t("items.lending.badge_to", { name: item.lentTo }) }}
      <template v-if="overdue"> · {{ $t("items.lending.overdue") }}</template>
    </span>
  </Badge>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import MdiHandExtended from "~icons/mdi/hand-extended";
  import { Badge } from "@/components/ui/badge";
  import { isLent, isOverdue, lendingDate, type Lendable } from "~/lib/lending";

  const props = defineProps<{
    item: Lendable;
    /** Only "Verliehen"/"Überfällig", for tight spaces like table rows. */
    compact?: boolean;
  }>();

  const { t } = useI18n();

  const lent = computed(() => isLent(props.item));
  const overdue = computed(() => isOverdue(props.item));

  const tooltip = computed(() => {
    const parts = [t("items.lending.badge_to", { name: props.item.lentTo })];
    const since = lendingDate(props.item.lentDate);
    if (since) {
      parts.push(t("items.lending.since", { date: fmtDate(since, "human", "date") }));
    }
    const due = lendingDate(props.item.lentReturnDate);
    if (due) {
      parts.push(t("items.lending.due", { date: fmtDate(due, "human", "date") }));
    }
    return parts.join(" · ");
  });
</script>
