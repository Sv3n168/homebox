import { describe, expect, test } from "vitest";
import { isLent, isOverdue, lendingDate } from ".";

describe("lending helpers", () => {
  test("isLent needs a non-blank lentTo", () => {
    expect(isLent({ lentTo: "Anna" })).toBe(true);
    expect(isLent({ lentTo: "  " })).toBe(false);
    expect(isLent({ lentTo: "" })).toBe(false);
    expect(isLent(null)).toBe(false);
  });

  test("lendingDate treats empty API values as unset", () => {
    expect(lendingDate("")).toBeNull();
    expect(lendingDate("2026-05-03")?.getDate()).toBe(3);
  });

  test("isOverdue compares the return date against today", () => {
    const today = new Date(2026, 9, 13, 15, 0);
    expect(isOverdue({ lentTo: "Anna", lentReturnDate: "2026-10-12" }, today)).toBe(true);
    expect(isOverdue({ lentTo: "Anna", lentReturnDate: "2026-10-13" }, today)).toBe(false);
    expect(isOverdue({ lentTo: "Anna", lentReturnDate: "" }, today)).toBe(false);
    expect(isOverdue({ lentTo: "", lentReturnDate: "2026-01-01" }, today)).toBe(false);
  });
});
