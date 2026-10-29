import type { OfflineHooks, OfflineRequest } from "../offline/adapter";

export enum Method {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE",
  PATCH = "PATCH",
}

export type ResponseInterceptor = (r: Response, rq?: RequestInit) => void;

export interface TResponse<T> {
  status: number;
  error: boolean;
  data: T;
  response: Response;
}

export type RequestArgs<T> = {
  url: string;
  body?: T;
  data?: FormData;
  headers?: Record<string, string>;
};

/** Gateway errors Cloudflare/reverse proxies return when the origin is unreachable. */
const UNREACHABLE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 530]);

/** A GET that hangs this long (weak signal in the basement) is answered offline. */
const GET_TIMEOUT_MS = 10_000;

/**
 * A request without an answer after this long triggers a quick check whether
 * the server is reachable at all. If it is, the request is only slow and is
 * waited for. If not, a GET is answered from the device (the request keeps
 * going in the background and refreshes the copy) and a write is queued.
 * Weak signal often means requests that neither succeed nor fail for a while.
 */
const FAST_FALLBACK_MS = 2_000;

const NO_ANSWER_YET = Symbol("no answer yet");

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data ?? {}), {
    status,
    headers: { "Content-Type": "application/json", "X-Homebox-Offline": "1" },
  });
}

export class Requests {
  private offline?: OfflineHooks;
  private baseUrl: string;
  private token: () => string;
  private headers: Record<string, string> = {};
  private responseInterceptors: ResponseInterceptor[] = [];

  /** Enables offline answers and queuing for this client (see lib/offline). */
  enableOffline(hooks: OfflineHooks) {
    this.offline = hooks;
  }

  addResponseInterceptor(interceptor: ResponseInterceptor) {
    this.responseInterceptors.push(interceptor);
  }

  private callResponseInterceptors(response: Response, request?: RequestInit) {
    this.responseInterceptors.forEach(i => i(response.clone(), request));
  }

  private url(rest: string): string {
    return this.baseUrl + rest;
  }

  constructor(baseUrl: string, token: string | (() => string) = "", headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl;
    this.token = typeof token === "string" ? () => token : token;
    this.headers = headers;
  }

  public get<T>(args: RequestArgs<T>): Promise<TResponse<T>> {
    return this.do<T>(Method.GET, args);
  }

  public post<T, U>(args: RequestArgs<T>): Promise<TResponse<U>> {
    return this.do<U>(Method.POST, args);
  }

  public put<T, U>(args: RequestArgs<T>): Promise<TResponse<U>> {
    return this.do<U>(Method.PUT, args);
  }

  public patch<T, U>(args: RequestArgs<T>): Promise<TResponse<U>> {
    return this.do<U>(Method.PATCH, args);
  }

  public delete<T>(args: RequestArgs<T>): Promise<TResponse<T>> {
    return this.do<T>(Method.DELETE, args);
  }

  private methodSupportsBody(method: Method): boolean {
    return method === Method.POST || method === Method.PUT || method === Method.PATCH;
  }

  private async do<T>(method: Method, rargs: RequestArgs<unknown>): Promise<TResponse<T>> {
    if (!this.offline) {
      return this.send<T>(method, rargs);
    }

    let req: OfflineRequest = {
      method,
      url: rargs.url,
      headers: { ...rargs.headers, ...this.headers },
      body: rargs.body,
      data: rargs.data,
    };
    req = this.offline.rewrite(req);
    const args = { ...rargs, url: req.url, body: req.body };

    const answerOffline = async (sent = false): Promise<TResponse<T> | null> => {
      const answer = await this.offline!.fallback({ ...req, sent });
      if (!answer) return null;
      return {
        status: answer.status,
        error: answer.status >= 400,
        data: answer.data as T,
        response: jsonResponse(answer.status, answer.data),
      };
    };

    if (this.offline.skipNetwork(req)) {
      return (await answerOffline()) ?? this.unreachable<T>();
    }

    // Known to be offline: answer from the device and check the connection
    // in the background instead of waiting for every request to time out.
    if (method === Method.GET && this.offline.knownOffline()) {
      this.offline.probe();
      return (await answerOffline()) ?? this.unreachable<T>();
    }

    let result: TResponse<T>;
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const sending = this.send<T>(method, args, method === Method.GET ? GET_TIMEOUT_MS : 0, controller);
      const first = await Promise.race([
        sending,
        new Promise<typeof NO_ANSWER_YET>(resolve => setTimeout(() => resolve(NO_ANSWER_YET), FAST_FALLBACK_MS)),
      ]);
      if (first === NO_ANSWER_YET) {
        // Slow server or no signal? A slow answer is still worth waiting for.
        // (If the request itself answers first, that is all we need.)
        const reachable = await Promise.race([this.offline.reachable(), sending.then(() => true)]);
        if (!reachable) {
          if (method === Method.GET) {
            sending.then(r => this.recordResult(req, r)).catch(() => {});
          } else {
            // Stop waiting: the write is queued (marked as possibly sent, so
            // the replay checks before creating anything twice).
            controller?.abort();
            sending.catch(() => {});
          }
          return (await answerOffline(true)) ?? this.unreachable<T>();
        }
        result = await sending;
      } else {
        result = first;
      }
    } catch (e) {
      // Network failure or timeout: the server never answered.
      const offline = await answerOffline(true);
      if (offline) return offline;
      throw e;
    }

    if (method === Method.GET && UNREACHABLE_STATUSES.has(result.status)) {
      return (await answerOffline()) ?? result;
    }

    this.recordResult(req, result);
    return result;
  }

  private recordResult<T>(req: OfflineRequest, result: TResponse<T>) {
    if (!this.offline || result.error) return;
    const isJSON = result.response.headers.get("Content-Type")?.startsWith("application/json");
    this.offline.record(req, isJSON ? result.data : undefined);
  }

  private unreachable<T>(): TResponse<T> {
    const data = { error: "offline" } as unknown as T;
    return { status: 503, error: true, data, response: jsonResponse(503, data) };
  }

  private async send<T>(
    method: Method,
    rargs: RequestArgs<unknown>,
    timeoutMs = 0,
    controller?: AbortController
  ): Promise<TResponse<T>> {
    const payload: RequestInit = {
      method,
      headers: {
        ...rargs.headers,
        ...this.headers,
      } as Record<string, string>,
    };

    const token = this.token();
    if (token !== "" && payload.headers !== undefined) {
      // @ts-expect-error - we know that the header is there
      payload.headers["Authorization"] = token;
    }

    if (this.methodSupportsBody(method)) {
      if (rargs.data) {
        payload.body = rargs.data;
      } else {
        // @ts-expect-error - we know that the header is there
        payload.headers["Content-Type"] = "application/json";
        payload.body = JSON.stringify(rargs.body);
      }
    }

    // The timeout covers the body as well: with weak signal the headers can
    // arrive and the body never does.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!controller && timeoutMs > 0 && typeof AbortController !== "undefined") {
      controller = new AbortController();
    }
    if (controller) payload.signal = controller.signal;
    if (controller && timeoutMs > 0) {
      const c = controller;
      timer = setTimeout(() => c.abort(), timeoutMs);
    }

    try {
      return await this.receive<T>(await fetch(this.url(rargs.url), payload), payload);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async receive<T>(response: Response, payload: RequestInit): Promise<TResponse<T>> {
    this.callResponseInterceptors(response, payload);

    const data: T = await (async () => {
      if (response.status === 204) {
        return {} as T;
      }

      if (response.headers.get("Content-Type")?.startsWith("application/json")) {
        try {
          return await response.json();
        } catch (e) {
          // Timed out or given up while reading: not an (empty) answer.
          if ((e as Error)?.name === "AbortError") throw e;
          return {} as T;
        }
      }

      return response.body as unknown as T;
    })();

    return {
      status: response.status,
      error: !response.ok,
      data,
      response,
    };
  }
}
