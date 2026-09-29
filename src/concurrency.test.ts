import { describe, expect, it } from "vitest";
import { mapConcurrent } from "./concurrency";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

function delay(ms: number): Promise<void> {
  return scheduler.wait(ms);
}

describe("mapConcurrent", () => {
  it("yields results in source order when later calls settle first", async () => {
    const mapped = mapConcurrent([30, 10, 20, 0], 4, async (ms) => {
      await delay(ms);
      return ms;
    });

    expect(await collect(mapped)).toEqual([30, 10, 20, 0]);
  });

  it("never holds more calls unsettled than the limit", async () => {
    let inFlight = 0;
    let most = 0;
    const mapped = mapConcurrent(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async (index) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await delay(index % 4);
        inFlight -= 1;
        return index;
      },
    );

    expect(await collect(mapped)).toHaveLength(20);
    expect(most).toBe(3);
  });

  it("pulls from an async source only as calls finish", async () => {
    let pulled = 0;
    // oxlint-disable-next-line typescript/require-await -- the test needs an async source, not an async step
    async function* source(): AsyncGenerator<number> {
      for (let index = 0; index < 10; index += 1) {
        pulled += 1;
        yield index;
      }
    }

    const mapped = mapConcurrent(source(), 2, (index) => Promise.resolve(index));
    const first = await mapped.next();

    expect(first.value).toBe(0);
    expect(pulled).toBe(2);
    await mapped.return(undefined);
  });

  it("rejects at the first failure in source order and closes the source", async () => {
    let pulled = 0;
    let closed = false;
    // oxlint-disable-next-line typescript/require-await -- the test needs an async source, not an async step
    async function* source(): AsyncGenerator<number> {
      try {
        for (let index = 0; index < 10; index += 1) {
          pulled += 1;
          yield index;
        }
      } finally {
        closed = true;
      }
    }

    const mapped = mapConcurrent(source(), 2, async (index) => {
      if (index >= 1) {
        throw new Error(`failed ${index}`);
      }
      await delay(5);
      return index;
    });

    await expect(collect(mapped)).rejects.toThrow("failed 1");
    expect(pulled).toBe(3);
    expect(closed).toBe(true);
  });

  it("yields nothing for an empty source", async () => {
    expect(await collect(mapConcurrent([], 2, (item) => Promise.resolve(item)))).toEqual([]);
  });
});
