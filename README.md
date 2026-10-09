# Logbook

System of record for the personal data I pull from APIs on a schedule. A cron-driven Worker polls a source, archives every response page in R2, normalizes it into D1, and publishes one row per event to [bendrucker/bendrucker.me](https://github.com/bendrucker/bendrucker.me).

Three sources feed it. GitHub supplies pull requests, reviews, issues, and commit counts from its GraphQL API. [Trakt](#trakt) supplies watch history and ratings from its REST API. [Instapaper](#instapaper) supplies bookmarks, highlights, and notes from its API v2. Other simple polled APIs can join them. Sources that deliver webhooks or files to decode belong in [Activity Hub](https://github.com/bendrucker/activity-hub) instead.

## Why

The website's own GitHub sync stores one aggregate row per repository per year. That shape cannot answer "this month", cannot count lifetime repositories without double counting one across years, and cannot produce a record like largest PR or most reviews in a week. Every new number on the homepage costs another aggregate table, a backfill script, and a cache validator. One row per event makes each of those a SQL query instead.

[Activity Hub](https://github.com/bendrucker/activity-hub) is the sibling project and the wrong home for a polled source. Its pipeline is built on one activity being one raw file: a webhook delivers a pointer, the original FIT or GPX becomes the immutable record in R2, and a container decodes it into Parquet. GitHub has no file per event, no webhook for repositories I contribute to but do not own, and nothing to decode. What carries over is the boundary layer rather than the pipeline: raw responses in R2 before anything normalizes them, Parquet into the same lake bucket, and the site's `Publish` entrypoint as the only write path.

## Architecture

One Worker, one D1 database, an hourly sync cron, a nightly lake cron, and R2 for both raw pages and lake output. No queues and no container.

```mermaid
flowchart TB
    api[GitHub GraphQL API]

    subgraph hub [logbook]
        cron[Hourly cron]
        worker[Worker]
        raw[(R2 logbook-raw)]
        d1[(D1 events)]
        feed[Feed publish]
        lakecron[Nightly lake build]
    end

    trakt[Trakt API]
    instapaper[Instapaper API v2]
    lake[(R2 activity-hub-lake, github/, trakt/, and instapaper/ prefixes)]
    site[bendrucker.me Publish]

    cron --> worker
    worker -->|search and contributionsCollection| api
    worker -->|history and ratings| trakt
    worker -->|bookmarks and highlights| instapaper
    api -->|response pages| raw
    trakt -->|response pages| raw
    instapaper -->|response pages| raw
    raw -->|normalize| d1
    d1 --> feed -->|code feed rows| site
    d1 --> lakecron --> lake
```

The raw bucket is the system of record. Rebuilding the event tables after a schema change replays those pages and spends no source requests, which matters when a full backfill is a few hundred search calls.

Lake tables land under a prefix per source, `github/`, `trakt/`, and `instapaper/`, in the `activity-hub-lake` bucket that Activity Hub already writes. Sharing one bucket is what lets a single DuckDB session join rides against pull requests by day, and it is the only real cross-project concern.

The site is a read-only consumer. The design routes writes to its D1 through the `Publish` entrypoint it exposes over a service binding, which validates every row on arrival and answers a bad shape with a `ValidationError`. The binding would carry no credential and tell the callee nothing about who called, leaving that method list as the whole security boundary. None of it exists yet: the service binding and the publish path land with the feed.

See [docs/design.md](docs/design.md) for the full design, the extraction budget, and the decisions still open.

## Data Model

GitHub rows are one per event, at the grain GitHub hands over without crawling each repository. Instapaper rows are one per bookmark, highlight, and folder.

| Table                   | Grain                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_requests`         | One PR I authored: repository, number, title, created at, merged at, closed at, state, additions, deletions, changed files, comment and review counts |
| `reviews`               | One review I gave: repository, PR number, state, submitted at, PR author                                                                              |
| `issues`                | One issue I opened: repository, number, title, created at, closed at, state, comment count                                                            |
| `commit_days`           | One day of commits for one repository: repository, day, commit count                                                                                  |
| `repositories`          | One repository the event tables join to: owner, name, description, url, stars, primary language, created at, fork, visibility                         |
| `trakt_plays`           | One play from my Trakt history: history ID, watched at, action, movie or episode, show                                                                |
| `trakt_ratings`         | One rating per title: movie, show, season, or episode, rating, rated at                                                                               |
| `trakt_titles`          | One title the plays and ratings join to: type, Trakt ID, title, year, external IDs, air dates, runtime, genres                                        |
| `instapaper_bookmarks`  | One bookmark: url, title, author, saved at, liked, archived, folder, progress, tags, and when it was deleted                                          |
| `instapaper_highlights` | One highlight: bookmark, text, note, position, created at                                                                                             |
| `instapaper_folders`    | One folder of my own: title, slug, position, public                                                                                                   |

A sync state table alongside these records the last window read per kind. Commits are daily counts because that is how `contributionsCollection` already exposes them. Per-commit history, comment bodies, and individual review comments stay out of the first version. Each one needs a walk of every PR in every repository, and per-PR counts give most of the analytics value at a hundredth of the requests.

## Sync

The hourly cron runs one `updated:{since}..{now}` search per event kind plus `contributionsCollection` for the current year. Each search window opens an hour behind that kind's watermark, since GitHub's search index lags writes and upserts keyed on node ID make the overlap free. A range matching more than the 1,000 results search returns halves at its midpoint, earliest half first, and the watermark climbs through each half as it lands. Kinds run one after another so the first the rate budget refuses ends the invocation.

A watermark is an ISO instant meaning synced through. It advances only after every page is in R2 and every row is in D1, and only forward. A backfill of an old month cannot rewind a caught-up kind. A kind with no watermark is skipped: a backfill sets the first one.

Backfill runs from an admin route against the same code path, paged so no invocation runs past its subrequest budget:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$WORKER/admin/backfill?kind=pr-authored&from=2012-12"
```

A call enqueues the kind's windows from `from` to the present in the `crawl_units` frontier and drains them until the rate budget stops it: months for the search kinds, years for `contributions` and the connection kinds below. It answers with the windows it fetched, the count still `pending`, and any `irreducible` windows. A window already in the frontier keeps its status, so calling again with the same `from` carries on where the last call stopped without refetching what finished. A call the rate budget or a GitHub secondary limit stopped also answers with `resumeAt`, and `bun run backfill` sleeps until then and calls again. Backfill requests go out at least two seconds apart. The hourly cron drains whatever share its own work leaves, so a large backfill also finishes unattended across hours.

A window whose response says it dropped data is split into narrower windows and marked `split`. Contributions and the connection kinds narrow down the calendar from a year to quarters, months, days, half days, and hours. A search month past 1,000 results halves into day ranges such as `2026-08-01--2026-08-15`, then days, half days, and hours. A window still truncated at an hour is marked `irreducible`. Its rows still land, since truncation drops whole items and leaves the returned ones intact.

## Rate Budget

GitHub's 5,000 GraphQL points an hour are shared with every other tool on the token, so Logbook spends within limits set as Worker vars:

| Var                   | Value | Limit                                                  |
| --------------------- | ----- | ------------------------------------------------------ |
| `RATE_FLOOR_SYNC`     | 1,000 | Remaining quota the hourly sync never spends below     |
| `RATE_FLOOR_BACKFILL` | 2,500 | Remaining quota a backfill never spends below          |
| `RATE_SHARE`          | 300   | Points Logbook spends per rate window, across all runs |
| `RATE_CAP_CRON`       | 40    | Points one cron invocation spends                      |
| `RATE_CAP_BACKFILL`   | 150   | Points one backfill call spends                        |

Each `sync_runs` row records the points it spent and the last `remaining` GitHub reported. The spend in the current rate window is the sum of `cost` over the runs started in it, so the ledger needs no table of its own. The budget checks every request before it goes out and refuses one that would cross a limit, which ends the invocation with the watermark where it was. A 403 or 429 naming a secondary limit ends it the same way.

Search misses some events GitHub counts: it hides issues in repositories that later turned Issues off. Three more backfill kinds, `issue-contributions`, `pr-contributions`, and `review-contributions`, page the cursor connections on `contributionsCollection` that list exactly what GitHub counts, and upsert into the same tables by node ID. Search stays, since only an `updated:` search finds an old event whose state changed. A connection window reads at most ten pages. It splits when the tenth page still announces more, or when it ends with fewer nodes than the connection's `totalCount`. Reviews on my own pull requests are dropped, as the review search excludes them.

Each contributions year is checked against the event tables for that year. A disagreement lands on the run as a note rather than an error, because a search gap and a private contribution the token cannot see look the same from here. The note carries `restrictedContributionsCount`, which counts the private ones. GitHub counts reviews once per pull request, including my own, so the note sets that figure against distinct pull requests: `reviews 75 (38 own) vs 37 PRs`, with the own count read from the year's archived review connection pages. When the archived issue or pull request pages list exactly as many events as GitHub reports, the note names the node IDs behind a gap: `issues 186 vs 101 (missing I_a, I_b and 83 more)`. `GET /admin/sync` reports it alongside the watermarks, each kind's pending and irreducible frontier windows, the last ten failures, and the most recent lake build.

## Trakt

The same hourly cron reads my public Trakt profile with the application's client ID, no OAuth. History reads from a day behind its watermark to now, and waits for the drain while backfill years are still enqueued. Ratings re-read in full every run. Pages archive under `raw/trakt/{kind}/{window}/{fetched_at}/{page}.json`. `RATE_CAP_TRAKT` caps the requests one invocation sends, and a 429 stops it with `resumeAt` from `Retry-After`.

Backfill history by year, from the year of `from` or, without it, the year of the oldest play:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/backfill?kind=trakt-history&from=2023-01"
```

The nightly lake cron re-reads the current year of history first, which catches plays logged late with an earlier date. A play backdated into a prior year needs `bun run backfill <url> trakt-history --from <year>-01`. Plays deleted and ratings removed on Trakt stay in D1.

## Instapaper

The same hourly cron reads Instapaper after GitHub and Trakt settle, through Instapaper's `instapaper-api` SDK. It lists my folders, then reads every bookmark changed across the account since the last pass, with the IDs of those deleted. Bookmarks that come back changed have their highlights requeued. Pages archive under `raw/instapaper/{kind}/{window}/{fetched_at}/{page}.json`. `RATE_CAP_INSTAPAPER` caps the requests one invocation sends, and a 429 stops it and reports `resumeAt`.

A backfill reads the whole account's bookmarks in one change listing, then every bookmark's highlights:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/backfill?kind=instapaper-bookmarks"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/backfill?kind=instapaper-highlights"
```

[docs/design.md](docs/design.md#gaps) covers the gaps: highlight edits on an unchanged bookmark, the backfill's size per invocation, and offset paging.

## Lake

A second cron rebuilds the lake nightly at 09:30 UTC, reading D1 and writing Snappy Parquet under `github/v1/`, `trakt/v1/`, and `instapaper/v1/` in `activity-hub-lake`. Every table encodes before any is written, so a table that fails leaves the bucket on the last complete build rather than mixing rebuilt tables with stale ones. Every source's tables build as one set. Before it builds, the cron re-reads the current year of Trakt history, and a failed re-read still leaves a build worth writing. `lake_builds` records each build with its per-table row counts, or the reason it failed.

To rewrite the tables before the next nightly build, run the same build from an admin route:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/lake"
```

## Secrets

| Secret                    | Location                              | Consumer                        |
| ------------------------- | ------------------------------------- | ------------------------------- |
| `GITHUB_TOKEN`            | Worker secret (`wrangler secret put`) | Every GitHub GraphQL request    |
| `INSTAPAPER_ACCESS_TOKEN` | Worker secret (`wrangler secret put`) | Every Instapaper request        |
| `ADMIN_TOKEN`             | Worker secret (`wrangler secret put`) | Bearer auth on the admin routes |

The GitHub token is a classic personal access token with no scopes, so the hub sees and publishes public activity only. [docs/design.md](docs/design.md#visibility) records the decision.

The Instapaper access token is a personal access token, generated for my own account on the [Applications page](https://www.instapaper.com/developers/applications). It doesn't expire. Without it the cron skips Instapaper and an Instapaper backfill answers 503.

`ADMIN_TOKEN` is optional. `/admin/sync`, `/admin/backfill`, and `/admin/lake` answer 404 while it is unset. A deployment that never sets one exposes no admin surface.

## Infrastructure

`wrangler.jsonc` owns the Worker, the `DB` D1 binding, the `RAW` and `LAKE` R2 bindings for `logbook-raw` and `activity-hub-lake`, both cron triggers, and public vars: `GITHUB_LOGIN` and `TRAKT_USER` for whose history the hub reads, `TRAKT_CLIENT_ID` for the Trakt application, sent as `trakt-api-key` and paired with no secret for public reads, the [rate budget](#rate-budget), `RATE_CAP_TRAKT`, and `RATE_CAP_INSTAPAPER`. The service binding to the site joins them when publishing lands. A merge to `main` deploys. After `check` passes, the deploy job applies D1 migrations, then runs `wrangler deploy`.

There is no Terraform here. Activity Hub needs it for a DNS record, a Workers route, and the Cloudflare Access applications in front of its admin routes. This hub is reached by cron and by a service binding. It has no hostname to manage. `/admin/sync` sits behind `ADMIN_TOKEN` alone, with no Access application in front of it.

## Development

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

`wrangler dev` reads `GITHUB_TOKEN`, `INSTAPAPER_ACCESS_TOKEN`, and `ADMIN_TOKEN` from `.dev.vars`, which is gitignored. A run with all of them left empty serves `/healthz` and answers the admin routes 404.

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `bun run dev`       | Runs the Worker locally                        |
| `bun run test`      | Runs the test suite                            |
| `bun run typecheck` | Type checks without emitting                   |
| `bun run lint`      | Lints                                          |
| `bun run format`    | Formats                                        |
| `bun run types`     | Regenerates Worker types from `wrangler.jsonc` |
| `bun run backfill`  | Walks `POST /admin/backfill` to completion     |

## Status

Extraction, normalization, the sync loop, and the lake build are written and deployed, with D1 migrations applied on each merge to `main`. bendrucker.me still runs its own GitHub sync. Publishing the feed comes next, and the open decisions in [docs/design.md](docs/design.md) come before it.
