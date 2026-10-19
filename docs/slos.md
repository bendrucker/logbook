# SLOs

Objectives and alerts for the data pipeline. The monitor Worker in `workers/monitor` records lake metrics hourly and evaluates alert rules against them from its first deploy. Every rule routes to `log`, so an alert is a structured log line and doesn't notify anyone. A rule moves to a notifying route once its log history shows it fires only on real incidents.

## Principles

- Alert on symptoms a reader of the data would notice: data that stops arriving, or arrives with holes. A 429, a 5xx, or a skipped kind is a cause. Causes belong in an investigation, not in an alert.
- Watch the outputs, not the intermediate inputs or outputs that cause them. Where an output can be observed in place, it is. A separate monitor Worker is the fallback for what can't be. Here that Worker is `logbook-monitor`, a second Worker in this repository that reads logbook's published lake tables and upstream truth and never reads the pipeline's run log. A refactor of how runs are recorded leaves every alert working, and the monitor can't share a bug with the code it watches.
- Each application monitors itself. activity-hub watches its own outputs from its own repository, since what a deep enrichment pipeline must guarantee has little in common with what a many-vendor puller must.
- Every alert is actionable or it gets deleted. A transient upstream failure that the next hour repairs never surfaces.
- Failures with no known cause go to Claude, which reads the pipeline's internals and proposes a fix.

The internal SLIs in [slis.md](slis.md) (`sync_runs`, `invocations`, `sli_samples`) stay, as diagnostics. They answer _why_ during an investigation. They never fire an alert.

## What the Monitor Observes

The monitor binds the `LAKE` bucket, which it only lists and reads, and will call each upstream's public API with its own credentials. That is all it touches. It has no binding to logbook's D1. It finds tables by listing logbook's published prefixes (`github/v1/`, `trakt/v1/`, `instapaper/v1/`, `music/v1/`), so a table added to the build is probed without a change to the monitor. Results land in its own D1 database, `logbook-monitor`, as one `metrics` row per raw value per run: `lake.age_seconds` per table and `lake.tables` per prefix. Collection records values and never judges them. Thresholds live only in the alert rules below.

| Probe             | Reads                                                                        | Good when                                                    | Cadence                      |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| Lake freshness    | Each table's newest object `uploaded` time (built)                           | Rewritten within 26h                                         | Hourly                       |
| Content freshness | The newest event upstream, and whether the lake holds it                     | Every upstream event older than the threshold is in the lake | Hourly                       |
| Completeness      | Upstream counts for a closed window, compared with lake rows for that window | The counts match                                             | Daily                        |
| End-to-end        | bendrucker.me's public pages, once the feed publishes there                  | The newest event a reader sees matches the lake              | Hourly, once the feed exists |

Content freshness compares against upstream rather than against the clock. "Newest row is older than 3h" false-alarms through every quiet week. "Upstream has a PR from 4h ago that the lake lacks" is the symptom itself. Lake freshness can't see it: the nightly build rewrites every table whether or not its source synced, so a revoked credential leaves fresh files with stale contents.

The probe (`src/content.ts`) reads the newest event time of one table per source straight from its Parquet file, asks upstream for the oldest item newer than that, and records `content.lag_seconds`: how long that item has been missing, or zero when upstream has nothing newer.

- GitHub: `pull_requests.created_at` for the login's own PRs, against `GET /search/issues?q=type:pr author:{login} created:>{newest}&sort=created&order=asc`.
- Trakt: `plays.watched_at`, against `GET /users/{user}/history?start_at={newest}`, whose last one-item page is the oldest play.
- Instapaper: `bookmarks.saved_at`, against the change listing since the newest, keeping bookmarks saved after it.

The normal lag tops out near a day, an item saved just after the nightly build, so the `content-lag` rule uses the same 26h as lake freshness.

Apple Music has no upstream to probe, because it is a manual import. It gets lake freshness only, against a threshold measured in months.

The lake builds nightly, so content freshness through the lake resolves to a day. That matches what consumers of the lake see today. When the site feed lands, the end-to-end probe gives hourly resolution at the point a reader actually looks, and that is the probe tracing joins up with: a probe failure carries the URL and the time, and an investigator follows the trace from the page back to the run.

Completeness covers the gaps that freshness can't see. A lost page in the middle of a backfilled month leaves the newest event intact. Each day, the probe asks GitHub search for the count of PRs authored, reviewed, and opened as issues for the month before last, then compares those counts with the lake's rows for that month. Trakt history is checked the same way, using the `X-Pagination-Item-Count` header for a closed month.

## Objectives

Each objective is measured over a rolling 28 days.

| SLO                           | Target                    | Budget over 28 days                |
| ----------------------------- | ------------------------- | ---------------------------------- |
| Content freshness, per source | 99% of hourly probes good | ~6.7 bad probes                    |
| Lake freshness, per table     | 99% of hourly probes good | ~6.7 bad probes                    |
| Completeness, per source      | 100% of daily probes good | none: any mismatch is a gap to fix |

## Alerts

Rules are config, in the `ALERT_RULES` var of `workers/monitor/wrangler.jsonc`, validated by `src/rules.ts` at the start of every run. A rule names a metric, one bound (`above` or `below`), a sample count `for`, and a route:

```jsonc
{ "name": "lake-stale", "metric": "lake.age_seconds", "above": 93600, "for": 2, "route": "log" }
```

A rule opens an alert for a target when its last `for` samples all breach, and resolves it on the first sample that doesn't. One open alert per rule and target absorbs repeats. Each open and resolve goes to the rule's route. `log` writes a `monitor.alert.opened` or `monitor.alert.resolved` event to Workers Logs and nothing else, which makes shadow mode a route rather than a phase: a new rule starts on `log`, and promotion is a one-word config change.

A backtest of these rules against the 28 days of `sli_samples` to 2026-10-18 found that the lake, GitHub, and Instapaper rules would never have opened an alert. Trakt freshness breached 14 times, all from 429s at :00, which the cron move to :17 is meant to fix.

The intended alerts, once routes beyond `log` exist:

1. **Data stale**: content or lake freshness is bad for two consecutive probes. It goes to Ben.
2. **Data missing**: a completeness probe finds a mismatch. It goes to Claude, since a gap is a bug or a missed backfill, and the fix is code or a backfill call.
3. **Monitor down**: the monitor stops pinging an external heartbeat service (Healthchecks.io or similar). It goes to Ben. Nothing on Cloudflare can watch the monitor if Cloudflare itself is down.

When a stale alert has no obvious cause, Claude takes it on as well. It reads `sync_runs`, the run's trace, and the archived R2 pages, then opens a draft PR or comments on the issue with what it found.

Alerts open a GitHub issue, labeled `pipeline-stale`, `pipeline-gap`, or `monitor-down`, on this repository. An open issue for the same probe absorbs repeats, so one incident is one notification. A probe that recovers comments on the issue and closes it.

Expected volume is near zero. Over the 28 days to 2026-10-18, run success was at least 99.85% for every GitHub kind. The two failures were 5xx responses that the next hour repaired, so none of them would have fired.

## Next

1. **Completeness.** Content freshness runs on the monitor's own credentials, which keep it from sharing a rate budget or a revocation with the pipeline: `GITHUB_TOKEN` (a scopeless classic token; search answers without one, but Workers egress shares the unauthenticated limit) and `INSTAPAPER_ACCESS_TOKEN`, each set with `wrangler secret put --config workers/monitor/wrangler.jsonc`. Trakt reads as the account through the monitor's own Trakt application (`TRAKT_CLIENT_ID` in the monitor's vars, a PKCE app with no secret) and an OAuth grant that `bun run monitor:trakt-login` stores in the monitor's `trakt_tokens` table, which the monitor refreshes itself. Without the Instapaper token, or without the Trakt grant, that source is skipped and logged. The daily completeness probe is still to build.
2. **Heartbeat.** Set `HEARTBEAT_URL` to a Healthchecks.io (or similar) ping URL, and the monitor pings it after every run.
3. **Notifying routes.** The monitor also writes every metric to the Analytics Engine dataset `logbook_monitor_metrics`, so Cloudflare Custom Alerts (`alert_type: custom_analytics` on the notification policies API) can evaluate the same rules as SQL, with threshold or two-window SLO detection and email or webhook delivery. They are in beta, and the Terraform provider's `cloudflare_notification_policy` schema lacks several of their filter keys, so the first one or two are created imperatively through the API and managing them as code is a later project.
