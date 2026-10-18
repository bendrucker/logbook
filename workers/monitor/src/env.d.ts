// A heartbeat monitor's ping URL, set with `wrangler secret put`. Unset, the
// monitor pings nothing.
interface Env {
  HEARTBEAT_URL?: string;
}
