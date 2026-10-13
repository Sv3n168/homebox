import { describe, expect, test } from "vitest";
import type { EntityOut, EntitySummary } from "../api/types/data-contracts";
import { findDuplicateGroups, mergeInto, nameSimilarity, normalizeName, pairKey, similarItems } from "./duplicates";

const s = (id: string, name: string) => ({ id, name, tags: [] }) as unknown as EntitySummary;

describe("names", () => {
  test("normalizeName ignores case, umlauts and punctuation", () => {
    expect(normalizeName("Akku-Schrauber (Bosch)")).toBe("akkuschrauberbosch");
    expect(normalizeName("Straßenkreide")).toBe("strassenkreide");
    expect(normalizeName("Glühbirne")).toBe(normalizeName("Gluhbirne"));
  });

  test("similarity tolerates typos but not different things", () => {
    expect(nameSimilarity("Akkuschrauber", "Akkuschrauber")).toBe(1);
    expect(nameSimilarity("Akkuschrauber", "Akkuschruber")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("Lichterkette warmweiß", "Lichterkette warmweiss")).toBe(1);
    expect(nameSimilarity("Lichterkette warmweiß", "Lichterkette kaltweiß")).toBeLessThan(0.9);
    expect(nameSimilarity("Kabel", "Kabeln")).toBeLessThan(0.9);
    expect(nameSimilarity("Box", "Box")).toBe(1);
  });
});

describe("findDuplicateGroups", () => {
  const items = [
    s("1", "Akkuschrauber"),
    s("2", "Akku-Schrauber"),
    s("3", "Akkuschruber"),
    s("4", "Leiter"),
    s("5", "Weihnachtsstern"),
    s("6", "Weihnachtssterne"),
  ];

  test("groups similar names", () => {
    const groups = findDuplicateGroups(items).map(g => g.map(i => i.id).sort());
    expect(groups).toEqual([
      ["1", "2", "3"],
      ["5", "6"],
    ]);
  });

  test("respects pairs marked as not duplicate", () => {
    const groups = findDuplicateGroups(items, new Set([pairKey("6", "5")])).map(g => g.map(i => i.id));
    expect(groups).toHaveLength(1);
  });

  test("similarItems finds what is being typed", () => {
    expect(similarItems("akku schrauber", items).map(i => i.id)).toEqual(["1", "2", "3"]);
    expect(similarItems("Hammer", items)).toEqual([]);
  });
});

describe("mergeInto", () => {
  const e = (over: Partial<EntityOut>) =>
    ({
      id: "x",
      name: "Akkuschrauber",
      quantity: 1,
      tags: [],
      fields: [],
      notes: "",
      description: "",
      manufacturer: "",
      modelNumber: "",
      serialNumber: "",
      parent: { id: "box" },
      entityType: { id: "t" },
      ...over,
    }) as unknown as EntityOut;

  test("adds quantities, unions tags, keeps notes and fills blanks", () => {
    const update = mergeInto(e({ id: "a", quantity: 2, tags: [{ id: "t1" }] as never, notes: "Akku defekt" }), [
      e({
        id: "b",
        quantity: 1,
        tags: [{ id: "t1" }, { id: "t2" }] as never,
        notes: "Ladegerät fehlt",
        manufacturer: "Bosch",
      }),
    ]);
    expect(update.quantity).toBe(3);
    expect(update.tagIds.sort()).toEqual(["t1", "t2"]);
    expect(update.notes).toBe("Akku defekt\n\nLadegerät fehlt");
    expect(update.manufacturer).toBe("Bosch");
    expect(update.parentId).toBe("box");
    expect(update.entityTypeId).toBe("t");
  });
});
