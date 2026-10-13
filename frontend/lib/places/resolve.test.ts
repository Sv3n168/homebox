import { describe, expect, test } from "vitest";
import { parseLabel } from "./resolve";

describe("parseLabel", () => {
  test("location and item links", () => {
    expect(parseLabel("https://homebox.example.de/location/7b0c3c1e-0e6a-4d1e-9a51-8f1f2d3c4b5a")).toEqual({
      kind: "entity",
      id: "7b0c3c1e-0e6a-4d1e-9a51-8f1f2d3c4b5a",
    });
    expect(parseLabel("/item/abc-123/")).toEqual({ kind: "entity", id: "abc-123" });
  });

  test("asset links", () => {
    expect(parseLabel("https://hb.example/a/000-042")).toEqual({ kind: "asset", assetId: "000-042" });
    expect(parseLabel("/assets/42")).toEqual({ kind: "asset", assetId: "42" });
  });

  test("anything else is not a label", () => {
    expect(parseLabel("4006381333931")).toBeNull();
    expect(parseLabel("https://example.com/something")).toBeNull();
  });
});
