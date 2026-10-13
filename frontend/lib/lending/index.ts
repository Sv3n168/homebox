import { parseDateOnly, toDateOnlyString } from "../datelib/dateOnly";

/** The lending fields every entity summary carries. */
export type Lendable = {
  lentTo?: string | null;
  lentDate?: Date | string | null;
  lentReturnDate?: Date | string | null;
};

export function isLent(item: Lendable | null | undefined): boolean {
  return !!item?.lentTo && item.lentTo.trim() !== "";
}

/** Normalises a date-only API value ("" when unset) to a local Date or null. */
export function lendingDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return parseDateOnly(toDateOnlyString(value));
}

/** Lent and the planned return date lies before today. */
export function isOverdue(item: Lendable | null | undefined, today: Date = new Date()): boolean {
  if (!isLent(item)) {
    return false;
  }
  const due = lendingDate(item!.lentReturnDate);
  if (!due) {
    return false;
  }
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return due < startOfToday;
}
