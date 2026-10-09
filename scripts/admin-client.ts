// What every script driving the Worker's admin routes needs: the token it
// presents and a base URL it can safely present it to.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function adminToken(): string {
  const value = Bun.env.ADMIN_TOKEN;
  if (value === undefined || value === "") {
    fail("ADMIN_TOKEN is unset");
  }
  return value;
}

// Every call carries ADMIN_TOKEN as a bearer, so a mistyped scheme would put
// the Worker's admin credential on the wire in the clear. wrangler dev serves
// loopback over http, which is the one place that cannot be helped.
export function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${value} is not a URL`);
  }
  if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname)) {
    fail(`${value} is not https, and ADMIN_TOKEN would travel in the clear`);
  }
  return url;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
