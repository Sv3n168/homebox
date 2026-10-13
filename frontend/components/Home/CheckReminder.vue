<template>
  <!-- Boxes with items that nobody has checked (or acknowledged) for 6 months. -->
  <div v-if="due.length > 0" class="rounded-xl border bg-card text-sm shadow-sm" data-testid="check-reminder">
    <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="open = !open">
      <MdiClipboardClockOutline class="size-5 shrink-0 text-amber-500" />
      <span class="grow">{{ $t("check_reminder.hint", { count: due.length }) }}</span>
      <MdiChevronDown class="size-5 shrink-0 transition-transform" :class="{ '-rotate-90': !open }" />
    </button>
    <ul v-if="open" class="divide-y border-t">
      <li v-for="box in due" :key="box.id" class="flex items-center gap-2 px-3 py-2" data-testid="check-reminder-row">
        <div class="min-w-0 grow">
          <NuxtLink :to="`/location/${box.id}`" class="block truncate font-medium">{{ box.name }}</NuxtLink>
          <div class="text-xs text-muted-foreground">
            {{
              box.checked
                ? $t("check_reminder.last", { date: fmtDate(box.checked, "human", "date") })
                : $t("check_reminder.never")
            }}
          </div>
        </div>
        <Button size="sm" variant="outline" as-child>
          <NuxtLink :to="`/location/${box.id}/check`">{{ $t("box_check.button") }}</NuxtLink>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          :disabled="busy === box.id"
          data-testid="check-reminder-ack"
          @click="acknowledge(box.id)"
        >
          {{ $t("check_reminder.ack") }}
        </Button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import type { EntityOut } from "~~/lib/api/types/data-contracts";
  import MdiClipboardClockOutline from "~icons/mdi/clipboard-clock-outline";
  import MdiChevronDown from "~icons/mdi/chevron-down";
  import { Button } from "@/components/ui/button";

  // A box is due when its last check, its last "not now" and its creation are
  // all older than REMIND_MONTHS. "Quittieren" stores today on the box, so the
  // reminder for it returns after another REMIND_MONTHS — on every device.
  const REMIND_MONTHS = 6;
  const CACHE_MS = 60 * 60 * 1000;

  type Due = { id: string; name: string; checked: string | null };

  const { t } = useI18n();
  const api = useUserApi();
  const { inbox } = useInbox();
  const { setField } = useBoxField();

  const due = ref<Due[]>([]);
  const open = ref(false);
  const busy = ref<string | null>(null);

  const field = (e: EntityOut, name: string) => e.fields?.find(f => f.name === name)?.textValue || null;

  function isDue(e: EntityOut, cutoff: Date): boolean {
    const dates = [field(e, CHECKED_FIELD), field(e, ACK_FIELD), String(e.createdAt)]
      .filter((d): d is string => !!d)
      .map(d => new Date(d))
      .filter(d => !isNaN(d.getTime()));
    return dates.length > 0 && Math.max(...dates.map(d => d.getTime())) < cutoff.getTime();
  }

  async function compute(): Promise<Due[]> {
    const { data, error } = await api.items.getLocations({ filterChildren: false });
    if (error) return [];
    const boxes = data.filter(l => (l.itemCount ?? 0) > 0 && l.id !== inbox.value?.id && !INBOX_RE.test(l.name.trim()));
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - REMIND_MONTHS);

    const result: Due[] = [];
    for (let i = 0; i < boxes.length; i += 6) {
      const details = await Promise.all(boxes.slice(i, i + 6).map(b => api.items.getLocation(b.id)));
      for (const { data: e } of details) {
        if (e && isDue(e, cutoff)) result.push({ id: e.id, name: e.name, checked: field(e, CHECKED_FIELD) });
      }
    }
    return result.sort((a, b) => (a.checked ?? "").localeCompare(b.checked ?? "") || a.name.localeCompare(b.name));
  }

  function readCache(): Due[] | null {
    try {
      const c = JSON.parse(sessionStorage.getItem(CHECK_REMINDER_CACHE) ?? "null") as { at: number; due: Due[] } | null;
      return c && Date.now() - c.at < CACHE_MS ? c.due : null;
    } catch {
      return null;
    }
  }

  function writeCache() {
    try {
      sessionStorage.setItem(CHECK_REMINDER_CACHE, JSON.stringify({ at: Date.now(), due: due.value }));
    } catch {
      // private mode: just recompute next time
    }
  }

  async function acknowledge(id: string) {
    busy.value = id;
    const ok = await setField(id, ACK_FIELD, isoToday());
    busy.value = null;
    if (!ok) {
      toast.error(t("check_reminder.ack_failed"));
      return;
    }
    due.value = due.value.filter(b => b.id !== id);
    writeCache();
  }

  onMounted(async () => {
    const cached = readCache();
    if (cached) {
      due.value = cached;
      return;
    }
    due.value = await compute();
    writeCache();
  });
</script>
