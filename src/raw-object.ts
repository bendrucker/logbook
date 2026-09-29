// R2 lists lexicographically, so a page number is padded to keep one fetch's
// pages in the order they were read.
const PAGE_DIGITS = 4;

export const OBJECT_SUFFIX = ".json";

export function pageName(page: number): string {
  return `${String(page).padStart(PAGE_DIGITS, "0")}${OBJECT_SUFFIX}`;
}

// Replay counts a fetch's pages against the highest one it archived, so the
// number `pageName` padded has to read back off a listed key.
export function pageNumber(key: string): number | null {
  if (!key.endsWith(OBJECT_SUFFIX)) {
    return null;
  }

  const name = key.slice(key.lastIndexOf("/") + 1, -OBJECT_SUFFIX.length);

  return /^\d+$/.test(name) ? Number(name) : null;
}

// Re-running a window writes new pages under a new fetch timestamp rather
// than replacing what a previous run saw, keeping a normalization bug
// diagnosable against the bytes that caused it. A false return means the key
// was already there.
export async function writeOnce(
  bucket: R2Bucket,
  key: string,
  body: string,
  customMetadata?: Record<string, string>,
): Promise<boolean> {
  const written = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    ...(customMetadata === undefined ? {} : { customMetadata }),
  });

  return written !== null;
}
