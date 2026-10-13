import { describe, expect, test, vi } from "vitest";
import { IllegalArgumentException, NotFoundException } from "@zxing/library";
import { TolerantReader } from "./reader";

describe("TolerantReader", () => {
  test("keeps scanning after an unexpected frame error", () => {
    vi.useFakeTimers();
    const reader = new TolerantReader();
    const ok = { getText: () => "/location/abc" };
    const frames = [new NotFoundException(), new IllegalArgumentException(), ok];
    vi.spyOn(reader, "decode").mockImplementation(() => {
      const f = frames.shift();
      if (f instanceof Error) throw f;
      return f as never;
    });
    const results: string[] = [];
    reader.decodeContinuously({} as HTMLVideoElement, r => {
      if (r) results.push(r.getText());
    });
    vi.advanceTimersByTime(1000);
    expect(results).toEqual(["/location/abc"]);
    reader.stopContinuousDecode();
    vi.useRealTimers();
  });
});
