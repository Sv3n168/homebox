import { describe, expect, test } from "vitest";
import type { EntitySummary } from "../api/types/data-contracts";
import {
  applyMoves,
  applyPatches,
  entityFromCreate,
  entityPath,
  parseAssetId,
  PENDING_FLAG,
  queryAsset,
  queryEntities,
} from "./query";

const locType = { id: "t-loc", name: "Location", isLocation: true } as EntitySummary["entityType"];
const itemType = { id: "t-item", name: "Item", isLocation: false } as EntitySummary["entityType"];

function e(over: Partial<EntitySummary> & { id: string; name: string }): EntitySummary {
  return {
    archived: false,
    assetId: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    description: "",
    entityType: itemType,
    insured: false,
    itemCount: 0,
    purchasePrice: 0,
    quantity: 1,
    soldDate: "",
    tags: [],
    lentTo: "",
    lentDate: "",
    lentReturnDate: "",
    ...over,
  } as EntitySummary;
}

const keller = e({ id: "keller", name: "Keller", entityType: locType });
const regal = e({ id: "regal", name: "Regal 1", entityType: locType, parent: keller });
const box = e({ id: "box", name: "Kiste Weihnachten", entityType: locType, parent: regal, assetId: "000-042" });
const lichter = e({
  id: "lichter",
  name: "Lichterkette",
  parent: box,
  quantity: 3,
  tags: [{ id: "deko", name: "Deko" } as never],
  createdAt: "2026-03-01T00:00:00Z",
});
const bohrer = e({
  id: "bohrer",
  name: "Bohrmaschine",
  parent: regal,
  description: "Akku 18V",
  lentTo: "Peter",
  imageId: "img",
  createdAt: "2026-02-01T00:00:00Z",
});
const alt = e({ id: "alt", name: "Alter Kram", parent: regal, archived: true });
const all = [keller, regal, box, lichter, bohrer, alt];

const q = (s: string) => queryEntities(all, new URLSearchParams(s));
const ids = (s: string) => q(s).items.map(i => i.id);

describe("queryEntities", () => {
  test("items by default, locations with isLocation", () => {
    expect(ids("")).toEqual(["bohrer", "lichter"]);
    expect(ids("isLocation=true")).toEqual(["keller", "box", "regal"]);
    expect(ids("isLocation=true&filterChildren=true")).toEqual(["keller"]);
  });

  test("archived only on request", () => {
    expect(ids("includeArchived=true")).toEqual(["alt", "bohrer", "lichter"]);
  });

  test("parentIds matches the direct location", () => {
    expect(ids("parentIds=box")).toEqual(["lichter"]);
    expect(ids("parentIds=regal&includeArchived=true")).toEqual(["alt", "bohrer"]);
  });

  test("search matches every word across name, description and tags", () => {
    expect(ids("q=akku")).toEqual(["bohrer"]);
    expect(ids("q=deko%20licht")).toEqual(["lichter"]);
    expect(ids("q=nothing")).toEqual([]);
    expect(ids("q=%23042&isLocation=true")).toEqual(["box"]);
  });

  test("tags, photo and lending filters", () => {
    expect(ids("tags=deko")).toEqual(["lichter"]);
    expect(ids("tags=deko&negateTags=true")).toEqual(["bohrer"]);
    expect(ids("onlyWithPhoto=true")).toEqual(["bohrer"]);
    expect(ids("onlyLent=true")).toEqual(["bohrer"]);
    expect(ids("onlyWithoutTags=true")).toEqual(["bohrer"]);
  });

  test("ordering and pagination", () => {
    expect(ids("orderBy=createdAt")).toEqual(["lichter", "bohrer"]);
    expect(ids("orderBy=name&orderDirection=desc")).toEqual(["lichter", "bohrer"]);
    const page = q("page=2&pageSize=1");
    expect(page.total).toBe(2);
    expect(page.items.map(i => i.id)).toEqual(["lichter"]);
  });

  test("locations get the summed quantity of their items", () => {
    const res = q("isLocation=true");
    expect(res.items.find(i => i.id === "box")?.itemCount).toBe(3);
  });

  test("details widen the search to serial numbers", () => {
    const res = queryEntities(all, new URLSearchParams("q=SN-998"), id =>
      id === "lichter" ? { serialNumber: "SN-998" } : undefined
    );
    expect(res.items.map(i => i.id)).toEqual(["lichter"]);
  });
});

describe("asset ids and paths", () => {
  test("parseAssetId accepts the printed and short forms", () => {
    expect(parseAssetId("000-042")).toBe(42);
    expect(parseAssetId("42")).toBe(42);
    expect(parseAssetId("#42")).toBe(42);
    expect(parseAssetId("")).toBeNull();
    expect(parseAssetId("abc")).toBeNull();
  });

  test("queryAsset finds the box behind a QR label", () => {
    expect(queryAsset(all, "42").items.map(i => i.id)).toEqual(["box"]);
    expect(queryAsset(all, "000-043").total).toBe(0);
  });

  test("entityPath walks up to the root", () => {
    expect(entityPath(all, "lichter")?.map(p => `${p.type}:${p.id}`)).toEqual([
      "location:keller",
      "location:regal",
      "location:box",
      "item:lichter",
    ]);
    expect(entityPath(all, "missing")).toBeNull();
  });
});

describe("entityFromCreate", () => {
  test("builds a pending entity from the create body", () => {
    const pending = entityFromCreate(
      "offline-1",
      { name: "Schraubenkiste", parentId: "box", tagIds: ["deko"], entityTypeId: "t-item", quantity: 2 },
      "2026-10-13T10:00:00Z",
      { all, tags: [{ id: "deko", name: "Deko" } as never], entityTypes: [itemType!] }
    );
    expect(pending.id).toBe("offline-1");
    expect(pending.parent?.id).toBe("box");
    expect(pending.location?.id).toBe("box");
    expect(pending.tags.map(t => t.name)).toEqual(["Deko"]);
    expect(pending.quantity).toBe(2);
    expect(pending[PENDING_FLAG]).toBe(true);
    // shows up in local queries once merged with the snapshot
    expect(queryEntities([...all, pending], new URLSearchParams("parentIds=box")).items.map(i => i.id)).toEqual([
      "lichter",
      "offline-1",
    ]);
  });
});

describe("applyMoves", () => {
  test("moved items show up in their new box and path", () => {
    const moved = applyMoves(all, [{ entityId: "lichter", parentId: "regal" }]);
    expect(queryEntities(moved, new URLSearchParams("parentIds=box")).items.map(i => i.id)).toEqual([]);
    expect(queryEntities(moved, new URLSearchParams("parentIds=regal")).items.map(i => i.id)).toEqual([
      "bohrer",
      "lichter",
    ]);
    expect(entityPath(moved, "lichter")?.map(p => p.id)).toEqual(["keller", "regal", "lichter"]);
  });

  test("later moves win, unknown targets are ignored", () => {
    const moved = applyMoves(all, [
      { entityId: "lichter", parentId: "regal" },
      { entityId: "lichter", parentId: "keller" },
      { entityId: "bohrer", parentId: "nowhere" },
    ]);
    expect(moved.find(e => e.id === "lichter")?.parent?.id).toBe("keller");
    expect(moved.find(e => e.id === "bohrer")?.parent?.id).toBe("regal");
    // input untouched
    expect(all.find(e => e.id === "lichter")?.parent?.id).toBe("box");
  });
});

describe("applyPatches", () => {
  const tags = [
    { id: "t1", name: "Werkzeug" },
    { id: "t2", name: "Vermisst" },
  ] as EntitySummary["tags"];

  test("quantity and tags from queued edits, latest wins", () => {
    const out = applyPatches(
      all,
      [
        { entityId: "bohrer", quantity: 3 },
        { entityId: "bohrer", quantity: 4 },
        { entityId: "lichter", tagIds: ["t2", "unknown"] },
      ],
      tags
    );
    expect(out.find(e => e.id === "bohrer")?.quantity).toBe(4);
    expect(out.find(e => e.id === "lichter")?.tags.map(t => t.name)).toEqual(["Vermisst"]);
    // untouched fields stay, input untouched
    expect(out.find(e => e.id === "bohrer")?.tags).toEqual(all.find(e => e.id === "bohrer")?.tags);
    expect(all.find(e => e.id === "bohrer")?.quantity).toBe(1);
  });

  test("a tag-only edit keeps the quantity", () => {
    const out = applyPatches(all, [{ entityId: "bohrer", tagIds: ["t1"] }], tags);
    expect(out.find(e => e.id === "bohrer")?.quantity).toBe(1);
    expect(out.find(e => e.id === "bohrer")?.tags.map(t => t.id)).toEqual(["t1"]);
  });
});
