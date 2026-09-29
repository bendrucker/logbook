import { APIError, Instapaper, RateLimitError } from "instapaper-api";
import type { z } from "zod";
import type { RequestCap } from "../request-cap";
import { changesResponse, foldersResponse, highlightsResponse } from "./schema";

// The most one page of `GET /bookmarks` holds.
export const PAGE_SIZE = 500;

// A 429 names no wait unless it carries `Retry-After`. An hour is the cron's
// cadence, so a stopped run resumes on the next one.
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

export class InstapaperRateLimited extends InstapaperResponseError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, status: number, body: string, cause: unknown) {
    super("InstapaperRateLimited", "Instapaper rate limit exceeded", status, body, { cause });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface InstapaperOptions {
  fetch?: typeof globalThis.fetch;
  requests?: RequestCap;
}

export interface InstapaperResponse<T> {
  data: T;
  // The bytes as received.
  body: string;
}

interface Exchange {
  status: number;
  body: string;
  retryAfter: string | null;
}

// The SDK sends each request and maps its errors. It returns parsed JSON that
// nothing has checked, so the bytes it read are validated here instead, the
// same way a replay reads them back from R2.
export class InstapaperClient {
  readonly #sdk: Instapaper;
  readonly #requests: RequestCap | undefined;
  #last: Exchange | null = null;

  constructor(accessToken: string, options: InstapaperOptions = {}) {
    // workerd's native fetch throws "Illegal invocation" when called with a
    // foreign `this`. An arrow wrapper keeps late binding without that risk.
    const transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#requests = options.requests;
    this.#sdk = new Instapaper({
      accessToken,
      fetch: async (url, init) => {
        const response = await transport(url, init);
        const body = await response.text();
        this.#last = {
          status: response.status,
          body,
          retryAfter: response.headers.get("retry-after"),
        };
        return { status: response.status, ok: response.ok, text: () => Promise.resolve(body) };
      },
    });
  }

  changes(
    since: number,
    offset: number,
  ): Promise<InstapaperResponse<z.infer<typeof changesResponse>>> {
    return this.#call(changesResponse, (sdk) =>
      sdk.bookmarks.changes(since, { limit: PAGE_SIZE, offset }),
    );
  }

  folders(): Promise<InstapaperResponse<z.infer<typeof foldersResponse>>> {
    return this.#call(foldersResponse, (sdk) => sdk.folders.list());
  }

  highlights(bookmarkId: number): Promise<InstapaperResponse<z.infer<typeof highlightsResponse>>> {
    return this.#call(highlightsResponse, (sdk) => sdk.highlights.list(bookmarkId));
  }

  // Admitted here rather than in the fetch, where the SDK would report a
  // refusal as a network failure.
  async #call<T>(
    schema: z.ZodType<T>,
    request: (sdk: Instapaper) => Promise<unknown>,
  ): Promise<InstapaperResponse<T>> {
    this.#requests?.admit();
    this.#last = null;
    try {
      await request(this.#sdk);
    } catch (error) {
      throw failure(error, this.#take());
    }
    const exchange = this.#take();
    if (exchange === null) {
      throw new Error("the Instapaper SDK resolved without sending a request");
    }
    return { data: validate(schema, exchange), body: exchange.body };
  }

  #take(): Exchange | null {
    const exchange = this.#last;
    this.#last = null;
    return exchange;
  }
}

function failure(error: unknown, exchange: Exchange | null): unknown {
  if (!(error instanceof APIError) || exchange === null) {
    return error;
  }
  if (error instanceof RateLimitError) {
    return new InstapaperRateLimited(
      retryAfter(exchange.retryAfter),
      exchange.status,
      exchange.body,
      error,
    );
  }
  return new InstapaperResponseError(
    "InstapaperApiError",
    `Instapaper responded ${exchange.status}: ${error.message}`,
    exchange.status,
    exchange.body,
    { cause: error },
  );
}

function retryAfter(header: string | null): number {
  const trimmed = header?.trim() ?? "";
  const seconds = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
}

function validate<T>(schema: z.ZodType<T>, exchange: Exchange): T {
  let data: unknown;
  try {
    data = JSON.parse(exchange.body);
  } catch (error) {
    throw new InstapaperResponseError(
      "InstapaperValidationError",
      "Instapaper response is not JSON",
      exchange.status,
      exchange.body,
      { cause: error },
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new InstapaperResponseError(
      "InstapaperValidationError",
      `Instapaper response did not validate: ${parsed.error.message}`,
      exchange.status,
      exchange.body,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
