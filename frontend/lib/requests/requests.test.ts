import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCESS_RELOAD_GAP_MS, AccessRedirectError, REAUTH_PARAM, accessFetch, setAccessHandlers } from "./access";
import { Requests } from "./requests";

/** What fetch returns with `redirect: "manual"` when Cloudflare Access redirects. */
function opaqueRedirect(): Response {
  return { type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const settledWithin = (p: Promise<unknown>, ms = 20) =>
  Promise.race([
    p.then(
      () => true,
      () => true
    ),
    new Promise(resolve => setTimeout(() => resolve(false), ms)),
  ]);

describe("Requests and Cloudflare Access", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let expired: ReturnType<typeof vi.fn>;
  let mayReload: boolean;
  let storage: Map<string, string>;

  beforeEach(() => {
    fetchMock = vi.fn();
    reload = vi.fn();
    expired = vi.fn();
    mayReload = true;
    storage = new Map();
    setAccessHandlers({ onExpired: expired, mayReload: () => mayReload });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { replace: reload, href: "https://hb.example/items?q=1" },
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const client = () => new Requests("/api/v1", "Bearer t");

  test("sends without following redirects, same-origin credentials, XHR marker for Access", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: 1 }));
    await client().get({ url: "/status" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/status",
      expect.objectContaining({ redirect: "manual", credentials: "same-origin" })
    );
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("Authorization")).toBe("Bearer t");
  });

  test("Access 401 (not JSON) counts as expired; reload bypasses the service worker", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } }));
    const pending = client().get({ url: "/entities" });
    expect(await settledWithin(pending)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    const target = new URL(reload.mock.calls[0]![0] as string);
    expect(target.pathname + "?q=" + target.searchParams.get("q")).toBe("/items?q=1");
    expect(target.searchParams.has(REAUTH_PARAM)).toBe(true);
  });

  test("Homebox's own 401 (JSON) is returned as before", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "valid authorization token is required" }));
    const r = await client().get({ url: "/entities" });
    expect(r.status).toBe(401);
    expect(r.data).toEqual({ error: "valid authorization token is required" });
    expect(reload).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
  });

  test("opening something: reloads the page and never settles", async () => {
    fetchMock.mockResolvedValue(opaqueRedirect());
    const pending = client().get({ url: "/entities" });
    expect(await settledWithin(pending)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
  });

  test("saving: no reload (form keeps its input), hint and an error answer instead", async () => {
    fetchMock.mockResolvedValue(opaqueRedirect());
    const r = await client().post({ url: "/entities", body: { name: "a" } });
    expect(r.error).toBe(true);
    expect(r.data).toEqual({ error: "access_expired" });
    expect(reload).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test("a GET while input may be unsaved or in the background: hint, no reload", async () => {
    mayReload = false;
    fetchMock.mockResolvedValue(opaqueRedirect());
    const r = await client().get({ url: "/entities" });
    expect(r.error).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test("background fetches (sync, status) only notify; telemetry is silent", async () => {
    fetchMock.mockResolvedValue(opaqueRedirect());
    await expect(accessFetch("/api/v1/status")).rejects.toBeInstanceOf(AccessRedirectError);
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(accessFetch("/api/v1/telemetry", {}, "silent")).rejects.toBeInstanceOf(AccessRedirectError);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads at most once within the gap, then only notifies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockResolvedValue(opaqueRedirect());

    void client().get({ url: "/entities" });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    const second = await client().get({ url: "/entities" });
    expect(second.error).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + ACCESS_RELOAD_GAP_MS + 1);
    void client().get({ url: "/entities" });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  test("does not reload when sessionStorage is unavailable (no loop protection)", async () => {
    vi.stubGlobal("window", {
      location: { replace: reload, href: "https://hb.example/items" },
      get sessionStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    fetchMock.mockResolvedValue(opaqueRedirect());
    const r = await client().get({ url: "/entities" });
    expect(r.error).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  test.each([
    [200, false],
    [201, false],
    [401, true],
    [403, true],
    [404, true],
    [500, true],
    [502, true],
  ])("status %i is returned as before (error=%s), no reload", async (status, error) => {
    fetchMock.mockResolvedValue(json(status, { status }));
    const r = await client().get<{ status: number }>({ url: "/entities" });
    expect(r.status).toBe(status);
    expect(r.error).toBe(error);
    expect(r.data).toEqual({ status });
    expect(reload).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
  });

  test("204 and network errors behave as before", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await client().delete({ url: "/entities/1" });
    expect(r.status).toBe(204);
    expect(r.data).toEqual({});

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client().get({ url: "/entities" })).rejects.toBeInstanceOf(TypeError);
    expect(reload).not.toHaveBeenCalled();
  });
});
