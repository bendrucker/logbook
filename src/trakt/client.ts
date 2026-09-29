import type { z } from "zod";

const ENDPOINT = "https://api.trakt.tv";
const USER_AGENT = "logbook (+https://github.com/bendrucker/logbook)";
const API_VERSION = "2";

// Trakt clamps a larger `limit` to the endpoint's maximum rather than refusing
// it, and the response headers report what it applied. 250 is the maximum its
// pagination guide names as common.
export const PAGE_LIMIT = 250;

// Raw storage keeps a failing response's bytes, so every failure after the
// bytes arrive carries them.
export class TraktResponseError extends Error {
  readonly body: string;
  readonly status: number;

  // The name is a literal per subclass rather than the constructor's own, which
  // a minified build would rename.
  constructor(name: string, message: string, status: number, body: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.status = status;
    this.body = body;
  }
}

export class TraktHttpError extends TraktResponseError {
  constructor(status: number, body: string) {
    super("TraktHttpError", `Trakt responded ${status}`, status, body);
  }
}

// A 429 names its wait in `Retry-After`.
export class TraktRateLimited extends TraktResponseError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, body: string) {
    super(
      "TraktRateLimited",
      `Trakt rate limit (429), retry after ${retryAfterSeconds}s`,
      429,
      body,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TraktValidationError extends TraktResponseError {
  constructor(message: string, body: string, cause: unknown) {
    super("TraktValidationError", `Trakt response did not validate: ${message}`, 200, body, {
      cause,
    });
  }
}

// Thrown before a request goes out, so a refusal spends nothing.
export class RequestCapReached extends Error {
  constructor(cap: number) {
    super(`request cap reached: sent ${cap} of ${cap} this invocation`);
    this.name = "RequestCapReached";
  }
}

// Trakt's limit is per application over five minutes and reports nothing on a
// success, so a count per invocation bounds the spend and a 429 is what reports
// the limit itself.
export class RequestCap {
  readonly #cap: number;
  #sent = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  get sent(): number {
    return this.#sent;
  }

  admit(): void {
    if (this.#sent >= this.#cap) {
      throw new RequestCapReached(this.#cap);
    }
    this.#sent += 1;
  }
}

// Trakt documents waiting at least `Retry-After` seconds. A 429 an upstream
// layer answers may carry none.
const DEFAULT_RETRY_SECONDS = 60;

export interface Pagination {
  page: number;
  limit: number;
  pageCount: number;
  itemCount: number;
}

// Null when the endpoint answered unpaginated, which Trakt's ratings list may.
export function readPagination(headers: Headers): Pagination | null {
  const page = header(headers, "x-pagination-page");
  const limit = header(headers, "x-pagination-limit");
  const pageCount = header(headers, "x-pagination-page-count");
  const itemCount = header(headers, "x-pagination-item-count");
  if (page === null || limit === null || pageCount === null || itemCount === null) {
    return null;
  }
  return { page, limit, pageCount, itemCount };
}

function header(headers: Headers, name: string): number | null {
  const value = Number(headers.get(name) ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export interface TraktOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  requests?: RequestCap;
}

export interface TraktResponse<T> {
  data: T;
  // The bytes as received.
  body: string;
  pagination: Pagination | null;
}

// Reads a public profile with the application's client ID alone. No OAuth
// token goes out, so Trakt serves what anyone can see.
export async function traktGet<T>(
  clientId: string,
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
  options: TraktOptions = {},
): Promise<TraktResponse<T>> {
  // workerd's native fetch throws "Illegal invocation" when called with a
  // foreign `this`. An arrow wrapper keeps late binding without that risk.
  const transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = new URL(path, options.endpoint ?? ENDPOINT);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  options.requests?.admit();
  const response = await transport(url, {
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "trakt-api-key": clientId,
      "trakt-api-version": API_VERSION,
    },
  });

  const body = await response.text();
  if (response.status === 429) {
    throw new TraktRateLimited(retryAfter(response.headers), body);
  }
  if (!response.ok) {
    throw new TraktHttpError(response.status, body);
  }

  return {
    data: validate(schema, parseJson(body), body),
    body,
    pagination: readPagination(response.headers),
  };
}

function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new TraktValidationError("body is not JSON", body, error);
  }
}

export function validate<T>(schema: z.ZodType<T>, data: unknown, body: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new TraktValidationError(parsed.error.message, body, parsed.error);
  }
  return parsed.data;
}
