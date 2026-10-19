import { z } from "zod";
import type { RequestCap } from "../request-cap";
import type { TraktAuth } from "./auth";

const ENDPOINT = "https://api.trakt.tv";
export const USER_AGENT = "logbook (+https://github.com/bendrucker/logbook)";
const API_VERSION = "2";

// Trakt clamps a larger `limit` to the endpoint's maximum rather than refusing
// it, and the response headers report what it applied. 250 is the maximum its
// pagination guide names as common.
export const PAGE_LIMIT = 250;

// Which Trakt endpoint answered: a data read, or the OAuth token endpoint a
// read refreshes through first. Only a data read's bytes belong in raw storage
// as a page.
export type TraktEndpoint = "api" | "oauth";

// Raw storage keeps a failing response's bytes, so every failure after the
// bytes arrive carries them.
export class TraktResponseError extends Error {
  readonly body: string;
  readonly status: number;
  readonly endpoint: TraktEndpoint;

  // The name is a literal per subclass rather than the constructor's own, which
  // a minified build would rename.
  constructor(
    name: string,
    message: string,
    status: number,
    body: string,
    options?: ErrorOptions & { endpoint?: TraktEndpoint },
  ) {
    super(message, options);
    this.name = name;
    this.status = status;
    this.body = body;
    this.endpoint = options?.endpoint ?? "api";
  }
}

function subject(endpoint: TraktEndpoint): string {
  return endpoint === "oauth" ? "Trakt token refresh" : "Trakt";
}

export class TraktHttpError extends TraktResponseError {
  constructor(status: number, body: string, endpoint: TraktEndpoint = "api") {
    super("TraktHttpError", `${subject(endpoint)} responded ${status}`, status, body, {
      endpoint,
    });
  }
}

// A 429 names its wait in `Retry-After`, and Trakt's own limiter names the
// limit it applied in `X-Ratelimit`. A 429 without that name came from a layer
// in front of Trakt, which the message says so a run log tells the two apart.
export class TraktRateLimited extends TraktResponseError {
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    body: string,
    limit: string | null = null,
    endpoint: TraktEndpoint = "api",
  ) {
    super(
      "TraktRateLimited",
      `${subject(endpoint)} rate limit (429, ${limit ?? "no X-Ratelimit"}), retry after ${retryAfterSeconds}s`,
      429,
      body,
      { endpoint },
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

// Trakt documents waiting at least `Retry-After` seconds. A 429 an upstream
// layer answers may carry none.
const DEFAULT_RETRY_SECONDS = 60;

// The two headers paging reads. Trakt also sends a limit and an item count,
// which nothing here needs to see before trusting the page count.
export interface Pagination {
  page: number;
  pageCount: number;
}

// Null when the endpoint answered unpaginated, which Trakt's ratings list may.
export function readPagination(headers: Headers): Pagination | null {
  const page = header(headers, "x-pagination-page");
  const pageCount = header(headers, "x-pagination-page-count");
  return page === null || pageCount === null ? null : { page, pageCount };
}

function header(headers: Headers, name: string): number | null {
  const value = Number(headers.get(name) ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export interface TraktOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  requests?: RequestCap;
  // Reads as the account when set. Without it Trakt serves what anyone can see.
  auth?: TraktAuth;
}

export interface TraktResponse<T> {
  data: T;
  // The bytes as received.
  body: string;
  pagination: Pagination | null;
}

// The client ID identifies the application on every request, and the OAuth
// token, when the options carry one, the account.
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

  const headers = new Headers({
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "trakt-api-key": clientId,
    "trakt-api-version": API_VERSION,
  });
  if (options.auth !== undefined) {
    headers.set("Authorization", `Bearer ${await options.auth.accessToken()}`);
  }

  options.requests?.admit();
  const response = await transport(url, { headers });

  const body = await response.text();
  if (response.status === 429) {
    options.requests?.limited();
    throw new TraktRateLimited(retryAfter(response.headers), body, limitName(response.headers));
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

export function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
}

const rateLimitHeader = z.object({ name: z.string() });

export function limitName(headers: Headers): string | null {
  const value = headers.get("x-ratelimit");
  if (value === null) {
    return null;
  }
  try {
    return rateLimitHeader.parse(JSON.parse(value)).name;
  } catch {
    return null;
  }
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
