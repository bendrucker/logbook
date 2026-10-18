# SLOs

Objectives and alerts over the SLIs in [slis.md](slis.md). This is a proposal: nothing evaluates or alerts on it yet, and the targets get calibrated once the SLIs have a few weeks of clean data. The hourly cron moved off :00 on 2026-10-18 to test whether Trakt's 429s came from a per-IP limit on the hour, and the targets wait on that result.

## Principles

- Alert on symptoms a reader of the archive would notice: data that is stale, or a pipeline that stopped running. A 429, a 5xx, or a skipped kind is a cause. It shows up in the SLIs and in an investigation, but it never pages on its own.
- Every alert is actionable or it is deleted. A transient upstream failure the next hour repairs costs error budget and nothing else.
- Failures with no known cause go to Claude, which reads the run log and traces and proposes a fix. Known upstream causes don't, since no fix exists in this repository.

## Objectives

Each window is a rolling 28 days.

| SLO                 | SLI                                                                          | Target | Budget over 28 days         |
| ------------------- | ---------------------------------------------------------------------------- | ------ | --------------------------- |
| Freshness           | Hourly samples under the kind's lag threshold, per source                    | 99%    | ~6.7 stale samples per kind |
| Invocation coverage | Hours with a finished hourly invocation                                      | 99.5%  | ~3.4 missing hours          |
| Run success         | Finished runs, skips excluded, that ended `ok` or `rate_limited`, per source | 99%    | ~7 failed GitHub runs       |

The lag thresholds are those in [slis.md](slis.md#freshness): 3h for GitHub and Instapaper, 6h for Trakt, 26h for the lake. Because a threshold is three or more sync intervals, a single failed or rate-limited run never makes data stale. Freshness only burns when something persists.

In the 28 days to 2026-10-18, run success was 99.85% for each GitHub kind, with two 5xx failures, and 100% for Instapaper. For Trakt it was 100% only because rate limits count as success: 25% of `trakt-history` runs were rate-limited. Freshness absorbs that today because history re-reads a day behind its watermark, so a missed hour loses no data. If the 429s persist after the cron move, they will show up as Trakt freshness burn, not as a separate objective.

Rate limiting has SLIs ([request rate limits](slis.md#request-rate-limits), [coverage lost](slis.md#coverage-lost-to-limits)) but no objective of its own. Its cost to a reader is staleness, which freshness already measures. An objective on it would alert on a cause.

## Alerts

There are three, and each opens at most one notification per incident.

1. **Stale data**: a kind's latest sample is over its threshold for two consecutive samples. It is routed to Ben. The second sample keeps one slow invocation from firing it.
2. **Pipeline stopped**: no hourly invocation has finished in 3 hours. It is routed to Ben. The Worker can't detect its own cron not firing, so the check runs outside it (see Decisions).
3. **Unknown failure**: a run fails with reason `internal` or `upstream.contract`. It is routed to Claude. Both reasons mean the code or our reading of an API is wrong, and only a code change repairs them.

The SRE workbook's multiwindow burn-rate alerts assume event volumes this pipeline doesn't have. At one sample per kind per hour, a one-hour window holds a single event, and a 14.4× burn rate isn't a meaningful statistic. The sustained-threshold rules above give the same "fast burn" behavior. Slow burn becomes a weekly digest instead of an alert: budget spent per SLO, sent only when any SLO has spent more than half of its budget.

Expected volume is near zero. Over the last 28 days, the two GitHub 5xx failures would have fired nothing, since freshness never crossed 3h and the failures are known causes.

## Routing to Claude

An unknown failure opens a GitHub issue on this repository, labeled `pipeline-failure`. The issue carries the kind, window, reason, error, `run_id`, and the trace query for that run. Claude picks up the label, reads `sync_runs`, the archived R2 pages for the window, and the run's trace, then opens a draft PR with a fix, or comments with what it found when there is no fix to make.

An issue is durable, deduplicates on an open issue for the same kind and reason, notifies Ben through GitHub's own settings, and gives Claude's proposal a natural place to land. The trade-off is a credential: the Worker's `GITHUB_TOKEN` is a scopeless classic PAT and must stay one (see [design](design.md#visibility)), so opening issues needs a second, fine-grained token scoped to issues on this one repository, minted in [bendrucker/infrastructure](https://github.com/bendrucker/infrastructure).

## Decisions

These need Ben's call before anything is built. The recommendation comes first in each.

1. **Where alerts are evaluated.**
   - Recommended: in the hourly invocation, right after the freshness sample. It costs no new infrastructure, but it can't catch a stopped cron.
   - Alternative: a Claude routine on a schedule. It needs no code, but it adds latency and spends tokens on every quiet check.
2. **The dead-man's switch for "pipeline stopped".**
   - Recommended: each invocation pings an external heartbeat monitor (for example, Healthchecks.io), and the monitor alerts when pings stop. It is cheap and independent of Cloudflare.
   - Alternative: activity-hub's cron checks logbook's `invocations`. This keeps everything on Cloudflare, but an account-level Workers outage silences both.
3. **Where human alerts go.**
   - Recommended: the same GitHub issue mechanism, labeled `pipeline-stale`, so one channel carries everything.
   - Alternative: push or email, which is faster to notice but adds another integration.
4. **The issue-writing token.**
   - Recommended: a fine-grained PAT or GitHub App token limited to `issues: write` on `bendrucker/logbook`, set with `wrangler secret put`.
