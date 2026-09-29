import type { z } from "zod";
import type { RequestCap } from "../request-cap";
import { authorize, type Credentials } from "./oauth";
import { errorResponse } from "./schema";

const ENDPOINT = "https://www.instapaper.com";
const USER_AGENT = "logbook (+https://github.com/bendrucker/logbook)";

// The most `bookmarks/list` returns. It has no cursor, so each folder shows
// only its most recent 500.
export const LIST_LIMIT = 500;

// The error codes this client acts on. Instapaper documents no number for its
// rate limit, only the code that reports it.
export const RATE_LIMITED = 1040;
export const PREMIUM_REQUIRED = 1041;
export const INVALID_BOOKMARK = 1241;
export const INVALID_FOLDER = 1242;

// Instapaper documents no wait with its limit. An hour is the cron's cadence,
// so a stopped run resumes on the next one.
const DEFAULT_RETRY_SECONDS = 60 * 60;

// Raw storage keeps a failing response's bytes, so every failure after the
// bytes arrive carries them.
export class InstapaperResponseError extends Error {
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

export class InstapaperHttpError extends InstapaperResponseError {
  constructor(status: number, body: string) {
    super("InstapaperHttpError", `Instapaper responded ${status}`, status, body);
  }
}

// An error object Instapaper answered with, whatever the HTTP status.
export class InstapaperApiError extends InstapaperResponseError {
  readonly code: number;

  constructor(
    code: number,
    message: string,
    status: number,
    body: string,
    name = "InstapaperApiError",
  ) {
    super(name, `Instapaper error ${code}: ${message}`, status, body);
    this.code = code;
  }
}

export class InstapaperRateLimited extends InstapaperApiError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message: string, status: number, body: string) {
    super(RATE_LIMITED, message, status, body, "InstapaperRateLimited");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class InstapaperValidationError extends InstapaperResponseError {
  constructor(message: string, status: number, body: string, cause: unknown) {
    super(
      "InstapaperValidationError",
      `Instapaper response did not validate: ${message}`,
      status,
      body,
      { cause },
    );
  }
}

export interface InstapaperOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  requests?: RequestCap;
}

export interface InstapaperResponse<T> {
  data: T;
  // The bytes as received.
  body: string;
}

// Every Full API method is a POST with its parameters in a form body and the
// OAuth parameters in the Authorization header.
export async function instapaperPost<T>(
  credentials: Credentials,
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
  options: InstapaperOptions = {},
): Promise<InstapaperResponse<T>> {
  const body = await send(credentials, path, params, options);
  if (!body.response.ok) {
    throw new InstapaperHttpError(body.response.status, body.text);
  }
  return {
    data: validate(schema, parseJson(body.text, body.response.status), body.text),
    body: body.text,
  };
}

// The xAuth exchange answers a query string rather than JSON.
export async function instapaperPostText(
  credentials: Credentials,
  path: string,
  params: Record<string, string>,
  options: InstapaperOptions = {},
): Promise<string> {
  const body = await send(credentials, path, params, options);
  if (!body.response.ok) {
    throw new InstapaperHttpError(body.response.status, body.text);
  }
  return body.text;
}

async function send(
  credentials: Credentials,
  path: string,
  params: Record<string, string>,
  options: InstapaperOptions,
): Promise<{ response: Response; text: string }> {
  // workerd's native fetch throws "Illegal invocation" when called with a
  // foreign `this`. An arrow wrapper keeps late binding without that risk.
  const transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = new URL(path, options.endpoint ?? ENDPOINT);
  const form = new URLSearchParams(params);

  options.requests?.admit();
  const response = await transport(url, {
    method: "POST",
    headers: {
      Authorization: await authorize("POST", url, form, credentials),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form,
  });
  const text = await response.text();

  const error = apiError(text);
  if (error !== null) {
    if (error.error_code === RATE_LIMITED) {
      throw new InstapaperRateLimited(
        retryAfter(response.headers),
        error.message,
        response.status,
        text,
      );
    }
    throw new InstapaperApiError(error.error_code, error.message, response.status, text);
  }
  return { response, text };
}

// Instapaper documents no status for an error, so its body decides.
function apiError(text: string): z.infer<typeof errorResponse>[0] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = errorResponse.safeParse(data);
  return parsed.success ? parsed.data[0] : null;
}

function retryAfter(headers: Headers): number {
  const header = headers.get("retry-after")?.trim() ?? "";
  const seconds = header === "" ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
}

// Instapaper asks clients to read a body that is not JSON as a 503.
function parseJson(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new InstapaperValidationError("body is not JSON", status, body, error);
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown, body: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new InstapaperValidationError(parsed.error.message, 200, body, parsed.error);
  }
  return parsed.data;
}
