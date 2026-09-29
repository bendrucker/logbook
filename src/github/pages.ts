import type { z } from "zod";
import { GitHubResponseError, graphql, validate, type GraphQLOptions } from "./client";
import type { PageInfo, RateLimit } from "./schema";

// A page announcing a successor whose cursor the pager already sent would serve
// the same results again for as long as it kept following it. The page is
// thrown rather than yielded so the window fails with its bytes archived and
// its watermark where it was.
export class RepeatedCursorError extends GitHubResponseError {
  readonly cursor: string;

  constructor(cursor: string, body: string) {
    super("RepeatedCursorError", `GitHub returned cursor ${cursor} again`, body);
    this.cursor = cursor;
  }
}

export interface CursorPagesOptions<T> extends GraphQLOptions {
  token: string;
  document: string;
  variables: Record<string, unknown>;
  schema: z.ZodType<T>;
  pageInfo: (data: T) => PageInfo;
  pageSize: number;
  // A connection that keeps announcing successors ends here.
  maxPages: number;
  // Where a connection another response already started picks up.
  after?: string;
}

export interface CursorPage<T> {
  page: number;
  data: T;
  rateLimit: RateLimit;
  body: string;
}

export async function* cursorPages<T>(
  options: CursorPagesOptions<T>,
): AsyncGenerator<CursorPage<T>> {
  let after: string | null = options.after ?? null;
  const sent = new Set<string>(after === null ? [] : [after]);
  let page = 0;
  let remaining = true;

  // Each request depends on the cursor the previous response returned, so the
  // pages are requested one at a time. A cursor that fails to advance ends the
  // loop before the page bound, as an error.
  while (remaining && page < options.maxPages) {
    // oxlint-disable-next-line no-await-in-loop -- each request needs the previous response's cursor
    const response = await graphql(
      options.token,
      options.document,
      { ...options.variables, first: options.pageSize, after },
      options,
    );

    const data = validate(options.schema, response.data, response.body);
    const pageInfo = options.pageInfo(data);
    if (pageInfo.hasNextPage && sent.has(pageInfo.endCursor)) {
      throw new RepeatedCursorError(pageInfo.endCursor, response.body);
    }
    page += 1;

    yield { page, data, rateLimit: response.rateLimit, body: response.body };

    remaining = pageInfo.hasNextPage;
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    if (after !== null) {
      sent.add(after);
    }
  }
}
