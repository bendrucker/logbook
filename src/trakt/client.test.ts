import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stubFetch } from "../../test/fetch-stub";
import { moviePlay, rateLimited, traktResponse } from "../../test/trakt-fixtures";
import {
  readPagination,
  RequestCap,
  RequestCapReached,
  TraktHttpError,
  TraktRateLimited,
  TraktValidationError,
  traktGet,
} from "./client";
import { historyPage } from "./schema";

const anything = z.array(z.unknown());

describe("traktGet", () => {
  it("identifies the app by client ID alone and sends no OAuth token", async () => {
    const { fetch, requests } = stubFetch(() => traktResponse([]));

    await traktGet("client-id", "/users/bendrucker/history", { page: "1" }, anything, { fetch });

    const [request] = requests;
    expect(request?.url).toBe("https://api.trakt.tv/users/bendrucker/history?page=1");
    expect(request?.headers.get("trakt-api-key")).toBe("client-id");
    expect(request?.headers.get("trakt-api-version")).toBe("2");
    expect(request?.headers.get("authorization")).toBeNull();
  });

  it("returns the bytes and the pagination Trakt reported", async () => {
    const { fetch } = stubFetch(() =>
      traktResponse([moviePlay(1, "2026-09-01T20:00:00.000Z")], {
        page: 2,
        pageCount: 3,
        itemCount: 501,
      }),
    );

    const response = await traktGet("id", "/x", {}, historyPage, { fetch });

    expect(response.pagination).toEqual({ page: 2, limit: 250, pageCount: 3, itemCount: 501 });
    expect(JSON.parse(response.body)).toHaveLength(1);
    expect(response.data[0]?.id).toBe(1);
  });

  it("stops on a 429 with the wait Retry-After names", async () => {
    const { fetch } = stubFetch(() => rateLimited(30));

    const failure = traktGet("id", "/x", {}, anything, { fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktRateLimited);
    await expect(failure).rejects.toMatchObject({ retryAfterSeconds: 30 });
  });

  it("keeps the body of a response it could not use", async () => {
    const { fetch } = stubFetch(() => new Response("locked", { status: 423 }));

    const failure = traktGet("id", "/x", {}, anything, { fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktHttpError);
    await expect(failure).rejects.toMatchObject({ status: 423, body: "locked" });
  });

  it("keeps the body of a response that fails validation", async () => {
    const { fetch } = stubFetch(() => traktResponse([{ id: "not a play" }]));

    const failure = traktGet("id", "/x", {}, historyPage, { fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktValidationError);
    await expect(failure).rejects.toMatchObject({ body: '[{"id":"not a play"}]' });
  });

  it("refuses a request past the cap before sending it", async () => {
    const { fetch, requests } = stubFetch(() => traktResponse([]));
    const requestCap = new RequestCap(1);

    await traktGet("id", "/x", {}, anything, { fetch, requests: requestCap });
    await expect(
      traktGet("id", "/x", {}, anything, { fetch, requests: requestCap }),
    ).rejects.toBeInstanceOf(RequestCapReached);

    expect(requests).toHaveLength(1);
  });
});

describe("readPagination", () => {
  it("reads nothing from a response without every header", () => {
    expect(readPagination(new Headers({ "X-Pagination-Page": "1" }))).toBeNull();
  });
});
