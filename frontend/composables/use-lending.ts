import { useI18n } from "vue-i18n";
import { toast } from "@/components/ui/sonner";
import type { EntityLending } from "~~/lib/api/types/data-contracts";

/** Lend / return go through PATCH so nothing but the lending fields changes. */
export function useLending() {
  const api = useUserApi();
  const { t } = useI18n();

  async function lend(id: string, lending: EntityLending): Promise<boolean> {
    const { error } = await api.items.patch(id, { id, lending });
    if (error) {
      toast.error(t("items.lending.toast.failed"));
      return false;
    }
    toast.success(t("items.lending.toast.lent", { name: lending.lentTo }));
    return true;
  }

  async function markReturned(id: string): Promise<boolean> {
    const { error } = await api.items.patch(id, {
      id,
      lending: { lentTo: "", lentDate: "", lentReturnDate: "" },
    });
    if (error) {
      toast.error(t("items.lending.toast.failed"));
      return false;
    }
    toast.success(t("items.lending.toast.returned"));
    return true;
  }

  return { lend, markReturned };
}
