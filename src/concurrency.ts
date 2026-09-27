// A Worker invocation holds at most six connections open at once, counting
// fetch and every R2 get, put and list. The runtime queues a seventh until one
// closes, so a seventh read started early finishes no sooner and holds one
// more body in memory.
export const OPEN_CONNECTIONS = 6;

// Maps each item of `source` with at most `limit` calls unsettled, yielding the
// results in source order. A rejection ends the iteration and closes `source`,
// so nothing is pulled past the item that failed.
export async function* mapConcurrent<T, R>(
  source: Iterable<T> | AsyncIterable<T>,
  limit: number,
  map: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const items = pull(source);
  const inFlight: Promise<R>[] = [];

  try {
    let exhausted = false;
    let head: Promise<R> | undefined;
    do {
      while (!exhausted && inFlight.length < limit) {
        // eslint-disable-next-line no-await-in-loop
        const next = await items.next();
        if (next.done === true) {
          exhausted = true;
        } else {
          inFlight.push(started(map(next.value)));
        }
      }

      head = inFlight.shift();
      if (head !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        yield await head;
      }
    } while (head !== undefined);
  } finally {
    await items.return(undefined);
  }
}

// One shape for a list and a generator, so the loop above pulls both the same
// way and can close either.
async function* pull<T>(source: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  yield* source;
}

// A call behind the one that failed may reject too, after the iteration has
// stopped awaiting it. The handler keeps that from surfacing as unhandled while
// the promise itself still rejects for whoever does await it.
function started<R>(pending: Promise<R>): Promise<R> {
  pending.catch(() => undefined);
  return pending;
}
