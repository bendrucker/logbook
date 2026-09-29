// OAuth 1.0a request signing (RFC 5849) with HMAC-SHA1, the only method
// Instapaper accepts. Web Crypto alone, so it runs under workerd and Bun.

export interface Credentials {
  consumerKey: string;
  consumerSecret: string;
  // Absent only for the xAuth exchange that obtains them.
  token?: string;
  tokenSecret?: string;
}

// Fixed by a test against a published signature. A live request draws fresh
// ones.
export interface Nonce {
  nonce: string;
  timestamp: number;
}

// RFC 3986 unreserved characters pass through. encodeURIComponent also leaves
// !'()* alone, which OAuth requires encoded.
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// The Authorization header for a request whose form body is `body`. The body
// and the URL's query both enter the signature, so neither can change after
// signing.
export async function authorize(
  method: string,
  url: URL,
  body: URLSearchParams,
  credentials: Credentials,
  nonce: Nonce = freshNonce(),
): Promise<string> {
  const token: [string, string][] =
    credentials.token === undefined ? [] : [["oauth_token", credentials.token]];
  const oauth: [string, string][] = [
    ["oauth_consumer_key", credentials.consumerKey],
    ["oauth_nonce", nonce.nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(nonce.timestamp)],
    ...token,
    ["oauth_version", "1.0"],
  ];
  const base = signatureBase(method, url, [...url.searchParams, ...body, ...oauth]);
  const key = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret ?? "")}`;
  const signature = await hmacSha1(key, base);

  const signed: (readonly [string, string])[] = [...oauth, ["oauth_signature", signature]];
  return `OAuth ${signed
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

export function signatureBase(
  method: string,
  url: URL,
  params: readonly (readonly [string, string])[],
): string {
  const normalized = params
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .toSorted(([aName, aValue], [bName, bValue]) =>
      aName === bName ? compare(aValue, bValue) : compare(aName, bName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  // URL drops a scheme's default port and lowercases the scheme and host, which
  // is the base URI the RFC asks for.
  const baseUri = `${url.protocol}//${url.host}${url.pathname}`;
  return [method.toUpperCase(), percentEncode(baseUri), percentEncode(normalized)].join("&");
}

// Byte order, which for percent-encoded ASCII is code unit order. localeCompare
// would sort by collation instead.
function compare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", imported, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

function freshNonce(): Nonce {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    nonce: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    timestamp: Math.floor(Date.now() / 1000),
  };
}
