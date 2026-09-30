// Secrets are set with `wrangler secret put` and never appear in
// wrangler.jsonc, so `wrangler types` cannot generate them. Optional because
// the admin route's behavior when its token is unset is part of its contract.
interface Secrets {
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
