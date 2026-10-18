# SLOs

Objectives and alerts for the data pipeline. This is a proposal: nothing evaluates or alerts on it yet, and the targets get calibrated once the probes have a few weeks of data.

## Principles

- Alert on symptoms a reader of the data would notice: data that stops arriving, or arrives with holes. A 429, a 5xx, or a skipped kind is a cause. Causes belong in an investigation, not in an alert.
- The symptom check lives outside the pipeline. A monitor Worker, a separate application with its own repository and deploy, observes the published outputs and upstream truth. It never reads the pipeline's run log. If a refactor of logbook or activity-hub changes how runs are recorded, every alert keeps working, and the monitor can't share a bug with the code it watches.
- Every alert is actionable or it gets deleted. A transient upstream failure that the next hour repairs never surfaces.
- Failures with no known cause go to Claude, which reads the pipeline's internals and proposes a fix.

The internal SLIs in [slis.md](slis.md) (`sync_runs`, `invocations`, `sli_samples`) stay, as diagnostics. They answer _why_ during an investigation. They never fire an alert.

## What the Monitor Observes

The monitor binds the `LAKE` bucket read-only and calls each upstream's public API with its own credentials. That is all it touches. It has no binding to logbook's D1 and no knowledge of which Worker writes which table, so it covers activity-hub's tables under `lake/v1/` the same way it covers logbook's.

| Probe             | Reads                                                                        | Good when                                                    | Cadence                      |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| Lake freshness    | Each table's `part-0.parquet` `uploaded` time                                | Rewritten within 26h                                         | Hourly                       |
| Content freshness | The newest event upstream, and whether the lake holds it                     | Every upstream event older than the threshold is in the lake | Hourly                       |
| Completeness      | Upstream counts for a closed window, compared with lake rows for that window | The counts match                                             | Daily                        |
| End-to-end        | bendrucker.me's public pages, once the feed publishes there                  | The newest event a reader sees matches the lake              | Hourly, once the feed exists |

Content freshness compares against upstream rather than against the clock. "Newest row is older than 3h" false-alarms through every quiet week. "Upstream has a PR from 4h ago that the lake lacks" is the symptom itself. Each probe makes one request per source:

- GitHub: `GET /users/{login}/events/public`.
- Trakt: `GET /users/{user}/history?limit=1`.
- Instapaper: the newest bookmark.

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

1. **Data stale**: content or lake freshness is bad for two consecutive probes. It goes to Ben.
2. **Data missing**: a completeness probe finds a mismatch. It goes to Claude, since a gap is a bug or a missed backfill, and the fix is code or a backfill call.
3. **Monitor down**: the monitor stops pinging an external heartbeat service (Healthchecks.io or similar). It goes to Ben. Nothing on Cloudflare can watch the monitor if Cloudflare itself is down.

When a stale alert has no obvious cause, Claude takes it on as well. It reads `sync_runs`, the run's trace, and the archived R2 pages, then opens a draft PR or comments on the issue with what it found.

Alerts open a GitHub issue, labeled `pipeline-stale`, `pipeline-gap`, or `monitor-down`, on the repository that owns the table. An open issue for the same probe absorbs repeats, so one incident is one notification. A probe that recovers comments on the issue and closes it.

Expected volume is near zero. Over the 28 days to 2026-10-18, run success was at least 99.85% for every GitHub kind. The two failures were 5xx responses that the next hour repaired, so none of them would have fired.

## Decisions

These need Ben's call before anything is built. The recommendation comes first in each.

1. **Where the monitor lives.**
   - Recommended: a new repository, `bendrucker/monitor`, deployed on its own pipeline. It is the cleanest separation of concerns.
   - Alternative: a second Worker under `workers/` in this repository. It means less to set up, but logbook's deploy then ships it, and the two share CI.
2. **Upstream credentials.**
   - Recommended: the monitor gets its own scopeless GitHub token, Trakt client ID, and Instapaper token, so it never shares a rate budget or a revocation with the pipeline. Its one request per source per hour won't dent any limit.
3. **The issue-writing token.**
   - Recommended: a fine-grained token limited to `issues: write` on the repositories that own tables, minted in `bendrucker/infrastructure`.
