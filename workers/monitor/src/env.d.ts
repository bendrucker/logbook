// A heartbeat monitor's ping URL, set with `wrangler secret put`. Unset, the
// monitor pings nothing.
interface Env {
  HEARTBEAT_URL?: string;
  // The monitor's own credentials, apart from the pipeline's so a revoked one
  // can't blind both. Without a GitHub token search still answers, at a lower
  // rate limit. Without an Instapaper token that source goes unprobed.
  GITHUB_TOKEN?: string;
  INSTAPAPER_ACCESS_TOKEN?: string;
}
