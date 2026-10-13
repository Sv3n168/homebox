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

    let result: TResponse<T>;
    try {
      result = await this.send<T>(method, args, method === Method.GET ? GET_TIMEOUT_MS : 0);
    } catch (e) {
      // Network failure or timeout: the server never answered.
      const offline = await answerOffline(true);
      if (offline) return offline;
      throw e;
    }

    if (method === Method.GET && UNREACHABLE_STATUSES.has(result.status)) {
      return (await answerOffline()) ?? result;
    }

    if (!result.error) {
      const isJSON = result.response.headers.get("Content-Type")?.startsWith("application/json");
      this.offline.record(req, isJSON ? result.data : undefined);
    }
    return result;
  }

  private unreachable<T>(): TResponse<T> {
    const data = { error: "offline" } as unknown as T;
    return { status: 503, error: true, data, response: jsonResponse(503, data) };
  }

  private async send<T>(method: Method, rargs: RequestArgs<unknown>, timeoutMs = 0): Promise<TResponse<T>> {
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      const controller = new AbortController();
      payload.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(this.url(rargs.url), payload);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.callResponseInterceptors(response, payload);

    const data: T = await (async () => {
      if (response.status === 204) {
        return {} as T;
      }

      if (response.headers.get("Content-Type")?.startsWith("application/json")) {
        try {
          return await response.json();
        } catch (e) {
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
