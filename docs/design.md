# Design

Logbook owns the personal data I pull from simple polled APIs. Webhooks and file decoding stay in [Activity Hub](https://github.com/bendrucker/activity-hub).

Three sources feed it. GitHub supplies pull requests, reviews, issues, and commit counts through its GraphQL API. [Trakt](#trakt) supplies watch history and ratings through its REST API. [Instapaper](#instapaper) supplies bookmarks, highlights, and the notes on them through its API v2. Logbook archives every response page in R2, normalizes them into D1, publishes a GitHub feed to [bendrucker/bendrucker.me](https://github.com/bendrucker/bendrucker.me), and writes Parquet into the lake [Activity Hub](https://github.com/bendrucker/activity-hub) already maintains. This document records the architecture and the decisions behind it. Most of it describes GitHub, the first source. The [README](../README.md) is the short version.

## Goals

- Own the data. Every API response page lands in R2 before anything parses it. A schema change then replays history instead of re-querying the source.
- One row per event, so month, year, and lifetime totals are each a SQL query rather than another aggregate table with its own backfill.
- Separate contributions to other people's repositories from work on my own, because those are different claims about what I do.
- Publish a code feed to bendrucker.me on the same terms as the ride feed: the site validates on arrival, owns its schema, and reads only.
- Join code against rides in one DuckDB session by writing Parquet into the shared lake bucket.

## Non-Goals

- Comment bodies, individual review comments, and per-commit history. Each needs a walk of every pull request in every repository or a query per repository per branch.
- Real-time freshness. An hourly cron is enough for a homepage, and no faster cadence is reliable while GitHub's search index lags writes by an unspecified interval.
- Webhooks. GitHub delivers them for repositories I own, which is a fraction of the repositories a contribution feed cares about.
- Multi-user support. One account, single-tenant everywhere.
- Queues and containers. Nothing here needs decoding, and the incremental run is a handful of requests inside one Worker invocation.

## Architecture

One Worker, one D1 database, an hourly sync cron, a nightly lake cron, and R2 for both raw pages and lake output.

```mermaid
flowchart TB
    subgraph gh [GitHub GraphQL API]
        search[search connection]
        contrib[contributionsCollection]
    end

    subgraph trakt [Trakt API]
        history[users history]
        ratings[users ratings]
    end

    subgraph ip [Instapaper API v2]
        bookmarks[bookmark changes]
        highlights[bookmark highlights]
    end

    subgraph cf [Cloudflare]
        cron[Hourly cron]
        extract[Extract]
        normalize[Normalize]
        raw[(R2 logbook-raw)]
        d1[(D1 events and sync state)]
        feed[Feed publish]
        lakebuild[Nightly lake build]
    end

    lake[(R2 activity-hub-lake, github/, trakt/, and instapaper/ prefixes)]
    site[bendrucker.me Publish entrypoint]

    cron --> extract
    extract --> search
    extract --> contrib
    extract --> history
    extract --> ratings
    history --> raw
    ratings --> raw
    extract --> bookmarks
    extract --> highlights
    bookmarks --> raw
    highlights --> raw
    search --> raw
    contrib --> raw
    raw --> normalize --> d1
    d1 --> feed --> site
    d1 --> lakebuild --> lake
```

#### Worker

The cron runs extraction, normalization, and publishing in one invocation. There is no queue between the stages because the incremental run is a handful of requests: one windowed search per event type plus one `contributionsCollection` call for the current year, then a Trakt history window and the ratings list, then one Instapaper change listing and the highlights of what changed. A backfill is larger and runs from an admin route or a script against the same code path, paged so no single invocation runs past its wall clock.

#### Raw Storage

Every response page is written to R2 before it is parsed, keyed by what produced it.

```text
raw/
  search/{kind}/{window}/{fetched_at}/{page}.json                               # kind is pr-authored, pr-reviewed, or issue
  search/{kind}/{window}/{fetched_at}/reviews/{pull request ID}/{page}.json     # review follow-up pages
  contributions/{window}/{fetched_at}.json                                      # 2015, 2015-Q3, 2015-07, 2015-07-14, 2015-07-14T00--2015-07-14T12, or 2015-07-14T00--2015-07-14T01
  contribution-events/{kind}/{window}/{fetched_at}/{page}.json                  # kind as in search, window as in contributions
  trakt/{kind}/{window}/{fetched_at}/{page}.json                                # kind is trakt-history or trakt-ratings
  instapaper/{kind}/{window}/{fetched_at}/{page}.json                           # instapaper-bookmarks by changes or folders, instapaper-highlights by bookmark ID
```

An object is written once and never rewritten. Re-running a window writes new pages under a new fetch timestamp rather than replacing what a previous run saw. A normalization bug stays diagnosable against the bytes that caused it. The bucket is small: a search page of 100 nodes is tens of kilobytes and the whole history is a few hundred pages.

#### Normalization

Normalization reads the newest fetch under each window and writes D1. It never calls GitHub. That split is what makes a schema change cost nothing: bump the shape, re-run normalization over the archived pages, and the event tables rebuild from the responses already on disk.

Upserts are keyed on GitHub's node ID, so re-normalizing the same page changes no rows. An event that appears in two overlapping windows lands once.

#### Lake

A nightly build reads D1 and writes Snappy Parquet in the `activity-hub-lake` bucket, one file set per table, under a prefix per source: `github/v1/`, `trakt/v1/`, and `instapaper/v1/`. The build is a full rebuild rather than an incremental merge, which is affordable because the corpus is tens of thousands of rows rather than millions of telemetry samples.

Sharing Activity Hub's bucket is deliberate. A query that asks which weeks had both high mileage and high review volume is one DuckDB session over two prefixes, and any other arrangement makes it a data transfer problem.

The build runs inside the Worker, which is what keeps containers a non-goal. `hyparquet-writer` encodes Parquet in pure JavaScript under workerd, and twenty thousand rows take tens of milliseconds.

Snappy rather than ZSTD because that writer ships no ZSTD compressor. Asking for ZSTD does not fail. It records the codec, stores the page uncompressed, and produces a file no reader accepts, so the codec is named at the call rather than left to a default. Activity Hub writes ZSTD from DuckDB in its container, and DuckDB reads either prefix without being told which.

Timestamps land as Parquet `TIMESTAMP_MILLIS` rather than the ISO strings D1 holds, since DuckDB then reads them as timestamps with no cast.

## Data Model

#### Identity

Every GitHub event's primary key is the GraphQL node ID GitHub returns, which is stable across renames of the repository and of the owner. `number` is stored beside it for readability, and `owner` and `name` come off the repository dimension each event joins to by `repository_id`.

#### Tables

| Table           | Columns                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_requests` | Node ID, repository, number, title, author, created at, merged at, closed at, state, additions, deletions, changed files, comment count, review count |
| `reviews`       | Node ID, repository, pull request number, state (approved, changes requested, commented), submitted at, pull request author                           |
| `issues`        | Node ID, repository, number, title, created at, closed at, state, comment count                                                                       |
| `commit_days`   | Repository, day, commit count                                                                                                                         |
| `repositories`  | Owner, name, description, url, stargazer count, primary language name and color, created at, fork, visibility                                         |

Additions, deletions, changed files, and the comment and review counts come off the pull request node's own fields. They cost nothing beyond the search page that already returned the node, and a record like largest PR falls out of them without opening a single diff.

`reviews` carries the pull request's author so reviews of my own work are separable from reviews I gave someone else. That distinction is the reason the table exists as its own grain rather than as a count on `pull_requests`.

Commits are per-repository daily counts because that is the finest grain `contributionsCollection` exposes without a query per repository per branch. `commitContributionsByRepository.contributions.nodes[]` carries a `commitCount` and an `occurredAt`, and one year of them is one request.

#### Operational Tables

`sync_state` is a key/value table. One key per kind holds the last window normalized successfully, and `updated_at` says when. The watermark advances only after the pages are in R2 and the rows are in D1. A failed run re-reads its window instead of skipping past it.

`sync_runs` holds one row per extraction attempt, written before the work starts so a run that dies mid-flight reads as one that never finished. It carries the kind, the window, page and row counts, whether the window truncated, an error, and a note the contributions cross-check writes when GitHub's yearly total disagrees with the event tables. `crawl_units` is the backfill frontier: one row per window with its parent and a status of `pending`, `done`, `split`, or `irreducible`. A unit is done only once its pages are in R2 and its rows are in D1. One the budget interrupts stays pending and restarts from its first page. `lake_builds` is that shape for the nightly build, carrying per-table row counts as JSON. `/admin/sync` reports the newest of each.

## Extraction

The search connection is the workhorse because it pages without bound when windowed by date. The `contributionsCollection` query supplies commits and the totals that cross-check everything else.

#### Search Windows

The `search` query returns [a maximum of 1,000 results](https://docs.github.com/en/graphql/reference/search#query-search) no matter how many matched. Its `issueCount` still reports the full match, so a window is truncated exactly when `issueCount` exceeds 1,000, and one matching exactly 1,000 is complete. Monthly windows keep every query well underneath it:

- `is:pr author:bendrucker created:2012-12-01..2012-12-31`
- `is:pr reviewed-by:bendrucker -author:bendrucker created:2012-12-01..2012-12-31`
- `is:issue author:bendrucker created:2012-12-01..2012-12-31`

The review search excludes my own pull requests. Replying to a review thread submits a `COMMENTED` review, so without the exclusion every reply on my own pull request counts as a review given. When the exclusion landed, 403 of 458 synced reviews for 2026 were those replies.

The upper bound is the month's real last day. A literal `-31` against a thirty-day month is a date GitHub's parser has to reinterpret, and these boundaries are what the whole cap mitigation rests on.

A month matching more than 1,000 splits in the backfill frontier. It halves into day ranges named for their ends, such as `2026-08-01--2026-08-15`, which halve again down to single days. A day splits into halves and a half into hours, named like the contributions windows (`2026-08-14T00--2026-08-14T12`) and queried on instants. An hour still past the cap is irreducible. Each window archives under its own key in `raw/search/{kind}/{window}/`.

The review search reads each pull request's reviews through a nested `reviews(author:, first: 100)` connection. A pull request whose nested page announces a successor gets a follow-up `node(id:)` query that pages the rest. Those pages archive beside the search page under `reviews/{pull request ID}/`, and replay merges them back in. A follow-up that fails still leaves its search page and the earlier follow-ups archived and normalized. The failed response lands as that pull request's next follow-up page rather than as a search page. A pull request whose `reviews.totalCount` still exceeds the nodes read flags its page as truncated, live and on replay. The search pager also stops with a `RepeatedCursorError` when a page announces a cursor it already sent, which would otherwise serve the same page until the page bound.

Walking those back to 2012 is 166 windows per event type for the whole history. The incremental run is the same code path with a different window: one `updated:{since}..{now}` query per type, where `since` sits an hour behind the watermark. The upper bound is what lets a range past 1,000 after an outage split: it halves at its midpoint, earliest half first, and the watermark climbs through each half as it lands. Backfill and incremental differ only in what dates go into the string.

#### Contributions Collection

`user.contributionsCollection(from, to)` takes at most a year per request. Its [`to` argument](https://docs.github.com/en/graphql/reference/users#object-user) defaults to the earlier of now and a year past `from`. The reference documents that default and says nothing about what a wider window does, so the client never sends one. A full history is one request per year. The backfill walks every calendar year from its first month, since a year with nothing in it costs a single request.

`commitContributionsByRepository` returns a plain list rather than a paginated connection, and its `maxRepositories` argument defaults to 25. Anything past the value it is given is dropped with no error and no cursor to follow. The query asks for 100. A window is truncated when it lists fewer repositories than `totalRepositoriesWithContributedCommits`, which the same response reports, so a window holding exactly 100 of 100 is complete.

Each repository's `contributions` list, one node per day with commits, is capped at 100 the same way. Its `totalCount` is the repository's commit total for the window, not its number of days, so a repository whose listed `commitCount` sums short of that total lost days. A final guard compares every listed commit against `totalCommitContributions`. A repository with commits on more than 100 days of a year loses the rest. A truncated window is fetched again as narrower windows down the calendar: a year to quarters, a quarter to months, a month to days, a day to halves, and a half to hours. An hour still truncated is irreducible. Each window is archived under its own key, and replay lists the year's prefix, takes the newest fetch of each window, and combines them. A window from a day up lists whole days, so any window naming a repository's day holds its count. A window narrower than a day counts part of each day, so its siblings add up. Replay takes the larger of a window's own count and its children's sum, which covers both. A live run fetching part of a day replays that day from the archive for the same reason.

The same query asks for the collection's own totals: `totalCommitContributions`, `totalPullRequestContributions`, `totalPullRequestReviewContributions`, `totalIssueContributions`, `totalRepositoriesWithContributedCommits`, and `restrictedContributionsCount`. Those are the cross-check. A year whose event table count disagrees with GitHub's own total means a search window truncated or a private contribution is being counted on one side and not the other.

`totalPullRequestReviewContributions` counts pull requests rather than reviews, and it includes reviews on my own pull requests, which the `reviews` table excludes. The cross-check therefore sets it against distinct pull requests by the year of their first review and reports the pair as `reviews 75 (38 own) vs 37 PRs`. The own count comes from the year's archived review connection pages, and is taken off GitHub's figure when those pages list as many pull requests as GitHub reports.

Issues and pull requests compare as sets when the year's archived connection pages list exactly as many events as GitHub's total. The note then names the node IDs on each side of a gap, `issues 186 vs 101 (missing I_a, I_b and 83 more)`, rather than a bare count. An archive of any other size is stale or partial, and the check falls back to the totals.

#### Contribution Connections

`contributionsCollection` also exposes cursor-paged `issueContributions`, `pullRequestContributions`, and `pullRequestReviewContributions`. They list exactly what GitHub counts, including issues search hides: an issue in a repository that later turned Issues off drops out of search while the collection still counts it. They run as three backfill kinds, `issue-contributions`, `pr-contributions`, and `review-contributions`, a second enumeration over the same event tables that upserts on node ID.

Each node carries its `Issue` or `PullRequest` with the fields the matching search selects, through a shared fragment, so normalization reuses the search row builders. A review node names one pull request, and the query reads that pull request's `reviews(author:, first: 100)`, so every review on it lands. Review nodes on my own pull requests are dropped, as the review search excludes them.

The windows are the contributions calendar windows, rooted at years. A unit reads at most ten pages of 100. One that exhausts its pages having read fewer nodes than the connection's `totalCount`, or stops at ten pages with a successor announced, is truncated and splits down the calendar like a commit window. The pager shares the search pager's cursor loop and its repeated-cursor guard.

Search stays. Connections enumerate by creation, so only an `updated:` search finds an old event whose state changed, and search also finds events GitHub declines to count as contributions. The union of both is the most complete set either source sees.

#### Rate Budget

The GraphQL API allows [5,000 points per hour](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api#primary-rate-limit) for a personal access token, and it scores a query on how many nodes it asks for. A search page of 100 nodes with no nested connection under it is one point. Nested connections multiply rather than add. A query that grows a sub-connection costs more than its node count reads on the surface. Every archived request so far has cost 1 point, including the reviewed-PR search with its nested `reviews(first: 100)`. The full backfill is a few hundred requests, which the share below spreads over a few rate windows. The incremental run is noise against it.

Each response carries `rateLimit.remaining`, `rateLimit.cost`, and `rateLimit.resetAt`. Only `rateLimit` reflects the point budget. The REST `GET /rate_limit` endpoint undercounts GraphQL spend.

The budget is shared with every other tool on the token, and those tools spent about 900 points in 18 minutes on one sampled hour. Logbook therefore spends within three limits, set as Worker vars:

- A floor on `remaining`: 1,000 for the hourly sync, which costs about 4 points and should still run on a busy hour, and 2,500 for a backfill, which yields half the budget to the other tools.
- A share of 300 points per rate window, whatever is left.
- A cap per invocation: 40 for the cron and 150 for a backfill call. The cap bounds wall clock and subrequests.

The ledger is derived. Each `sync_runs` row records the points it spent and the last `remaining` it saw, and the spend in the current window is the sum of `cost` over runs started since `resetAt` minus an hour. A request goes out when the last `remaining` minus its expected cost stays at or above the floor, the window's spend stays within the share, and the invocation's spend stays within the cap. The first request of an invocation is what learns the window, so it goes out on the cap alone. A refusal ends the invocation on a watermark it can resume from, and reports the reset to wait for.

GitHub also documents secondary limits: 100 concurrent requests and 2,000 points a minute for GraphQL. Logbook sends one request at a time. A backfill spaces requests at least two seconds apart, which keeps search within the 30 a minute GitHub documents for REST search in case GraphQL search shares it. A 403 or 429 carrying `retry-after` or a secondary-limit message stops the invocation the way a refusal does, and reports the wait.

#### Validation

Responses are validated with zod at the boundary, types are inferred from the schemas, and nothing is cast. Two patterns in the site's existing `packages/github/src/schema.ts` are worth carrying over whatever happens to that package:

- A `nodes()` helper collapsing a connection's nullable list of nullable entries into a plain list, since callers only ever iterate it.
- A `pageInfo` discriminated union pairing `hasNextPage: true` with a required `endCursor`. A page that announced a successor without the cursor to reach it would otherwise send the paginator back to the first page for as long as it kept going.

## Site Integration

#### Feed Contract

The hub publishes a `code_feed` the way Activity Hub publishes `activity_feed`: one row per event, storing what GitHub said and converting nothing. The site's `Publish` entrypoint gains a method, or a second entrypoint, that validates each row by name on arrival.

The service binding carries no credential and gives the callee no caller identity. The method list is the entire security boundary: one event per call, upsert and delete only, no bulk write and no read. A shape violation comes back as a `ValidationError`. Only an error's `name` and `message` cross the RPC boundary, which is why the hub branches on that name to park a row that will never be valid instead of retrying it.

Publishing is driven off D1 rather than off the extraction watermark. Each event row records when it was last published, and the cron sends whatever the normalizer touched more recently than that. An RPC failure that is not a `ValidationError` leaves the marker unmoved and the row goes again on the next run. A site outage costs a retry rather than a re-extraction.

The repository dimension publishes too. The site's `repos` table exists only to serve the code page. The hub owning it removes the last reason for the site to talk to GitHub at all.

#### Cache Validators

The site's activity pages and homepage key their ETags on `sync_state.version`, which `recordSync` bumps when a sync changed rows. Whatever the publish path writes has to bump that same version or those pages serve stale ETags against fresh data. `src/middleware.ts` and `src/middleware/cache.ts` read it.

#### Site Retirements

Once the hub publishes, running both syncs means two writers disagreeing about the same page. These go:

- `workers/github`, the hourly cron.
- `packages/github`, the client.
- `scripts/backfill-github-activity.ts` and `scripts/fetch-github-activity.ts`.
- The `repo_activity` schema, one aggregate row per repository per year.

`src/pages/activity/code.astro` and `src/activity/query.ts` move onto the feed.

Site migrations apply to production D1 only on push to `main`, and PR previews share the production database. A preview cannot read a table its own migration has not applied yet. The schema change lands and merges before the code that reads it.

#### Homepage Needs

The feed exists to answer these without a bespoke table per question:

- Totals by month, by year, and all time, for pull requests, reviews, and a third figure that sums cleanly across periods. Commits work. Repositories do not, because a repository touched in two years is one repository and two rows.
- Lifetime records for a ticker: first repository year, most-starred repositories contributed to, largest pull request by changed lines.
- The recent-repositories list the code rail already shows.

## Backfill

Backfill and incremental sync are the same code with different windows, so there is no second implementation to keep correct.

- Walk monthly search windows back to 2012 for each event type. I created my first repository on 2012-12-27, and nothing earlier will match.
- Walk `contributionsCollection` per calendar year from the backfill's first month.
- Page the three contribution connections per year, which recovers events the search index hides.
- Write every page to R2, then normalize.

It runs from an admin route or a local script. A call enqueues root windows in `crawl_units` and drains the frontier until the rate budget's cap, so a single invocation stays inside its wall clock and the next call resumes from the frontier. The hourly cron drains what share its own work leaves, so a large backfill finishes unattended.

Re-normalizing costs no GitHub requests, which is the point of writing raw pages first. The event tables can be rebuilt as many times as the schema changes.

For sizing: the site's current tables report 62 repositories touched in 2026, with 852 pull requests, 28 reviews, and 321 issues for that year. Extrapolating over a decade puts the event tables in the low tens of thousands of rows, which is small for D1 and smaller for Parquet.

## Operations

- The hourly cron runs one `updated:{since}..{now}` search per event type plus one `contributionsCollection` call for the current year, then reads [Trakt](#trakt) history and ratings, then runs an [Instapaper](#instapaper) pass.
- A second cron rebuilds the lake at 09:30 UTC. It sits off the hour so it never shares an instant with a sync invocation, and `scheduled` tells the two apart by the cron expression.
- `GITHUB_TOKEN`, `TRAKT_CLIENT_ID`, `INSTAPAPER_ACCESS_TOKEN`, and `ADMIN_TOKEN` are Worker secrets, set with `wrangler secret put`.
- The deploy job applies migrations on merge to `main` once `CLOUDFLARE_API_TOKEN` is set, which matches how the site and Activity Hub both work. Until then they apply by hand with `wrangler d1 migrations apply DB --remote`.
- An admin route reports the last successful sync per event type, the lag on the oldest window still unread, recent failures, and the last lake build, in the shape of Activity Hub's `/admin/pipeline`.
- The `contributionsCollection` totals are checked against event table counts per year. Drift is the signal that search missed something, such as an issue in a repository that later turned Issues off. Search hides it, and the totals still count it. A backfill of the contribution connections fills it, and the note names the node IDs still behind a gap.
- The backfill is roughly 500 search requests plus one per year, well inside the 10,000 subrequests a paid Workers invocation gets. Paging it across invocations answers the wall clock rather than a platform ceiling. The free tier's 50 subrequests would bind first.
- The [rate budget](#rate-budget) reads `rateLimit` off each response and refuses a request before it crosses a limit, rather than waiting for a 403.

## Risks

- The search cap drops results without an error. `issueCount` past 1,000 is the only signal. Monthly windows keep the real counts far below it, and a window past it splits down to hours.
- GitHub's search index lags writes by an unspecified interval, so an `updated:` window anchored exactly at the last sync can miss an event indexed late. The window overlaps the previous one, and upserts keyed on node ID make the overlap free.
- `commitContributionsByRepository` returns a fixed-length list and reports no truncation beyond the totals beside it. Calendar splitting recovers both overflowing days and repositories past the 100 cap, down to an hour. An hour that touched more than 100 repositories stays irreducible and flagged.
- `restrictedContributionsCount` counts contributions hidden from the viewer. With a token that sees no private repository, that is every private contribution, so the cross-check reports it beside the gaps instead of subtracting it.
- Search discovers only what exists. A pull request or repository deleted on GitHub stops matching every window and its rows go stale in place. Nothing here reconciles that, and a periodic re-walk of past windows is the only cheap detector.
- A public repository that goes private drops out of every later search, and the raw bucket becomes the only copy of its events.
- The cutover has two writers on the site's code page. Retiring the site's sync belongs in the same change that turns on publishing.
- A play deleted on Trakt stays in `trakt_plays`. History lists what exists, and nothing compares D1 against it. A rating removed on Trakt stays in `trakt_ratings` the same way. The full re-read every hour would make reconciling them cheap, but nothing does.
- Trakt's history filter reads `watched_at`. A play logged today with a date in a prior year falls outside every hourly window and the nightly re-walk of the current year. It lands only through `bun run backfill <url> trakt-history --from <that year>-01`.
- [Gaps](#gaps) lists what the Instapaper sync leaves out.

## Trakt

Trakt is the second source: every play in my watch history and every rating, with title metadata from `extended=full`.

#### Access

Both endpoints read a public profile with the application's client ID alone. `GET /users/{TRAKT_USER}/history` and `GET /users/{TRAKT_USER}/ratings` carry `trakt-api-version: 2` and `trakt-api-key` and no OAuth token, so there is no refresh flow to keep alive. `TRAKT_CLIENT_ID` is a Worker secret and `TRAKT_USER` a var. Making the profile private would stop the sync. Switching to OAuth would fix it.

#### Tables

| Table           | Grain                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `trakt_plays`   | One play: Trakt's history ID, watched at, action (scrobble, checkin, watch), movie or episode, title, show      |
| `trakt_ratings` | One rating per title: movie, show, season, or episode, rating 1 to 10, rated at, show                           |
| `trakt_titles`  | One title keyed on type and Trakt ID: slug, title, year, season and number, IMDb, TMDB, and TVDB IDs, air dates |

A play is keyed on Trakt's history `id`. A rating has no ID of its own, and Trakt holds one per title, so it is keyed on the title. Plays and ratings join to `trakt_titles` on `(type, trakt_id)`. An episode or season also names its show, and the show is a title too. `genres` is a JSON array in D1 and in Parquet. `trakt_plays.id` is `INT64` in Parquet because Trakt documents it as int64.

#### Extraction

History pages 250 items at a time, following `X-Pagination-Page-Count` from each response instead of computing pages from the requested limit, which Trakt may clamp. The bodies are bare JSON arrays, so the pagination headers are stored as R2 custom metadata. Replay reads them to tell a finished fetch from one that stopped partway, and rebuilds from the newest finished fetch of a window.

The hourly cron reads history from a day behind the watermark to now, then the whole ratings list. Trakt accepts full ISO timestamps for `start_at` and `end_at` and includes both bounds, even though its reference shows only dates. The day of overlap catches plays logged a little late. Re-reading those plays is harmless, because rows upsert on the history ID. Ratings have no window filter, and the list is small, so each run re-reads it and upserts every row. The ratings watermark records the last full read.

A backfill that stopped partway leaves the history watermark at the end of the last year it finished. A window from there to now could need more requests than the cap allows, so it would fail every hour without advancing, and ratings and the backfill queue behind it would never run. So the hourly history read waits while any history year is still enqueued in `crawl_units`, and the hourly drain of that queue finishes those years first. The current year is the last unit, and it carries the watermark to now.

The nightly lake cron re-reads the whole current year of history before it builds, which catches plays logged late with a date earlier in the year. It leaves the watermark alone.

#### Rate Limit

Trakt documents 500 unauthenticated GET requests every five minutes per application, and its responses carry no header reporting what is left. There is no point budget to account against, so Logbook caps the requests one invocation sends at `RATE_CAP_TRAKT`, and a 429 ends the invocation with `resumeAt` read from `Retry-After`. Trakt runs record `cost` 0 in `sync_runs` so they stay out of GitHub's point ledger. `pages` counts their requests.

#### Backfill

History backfills in yearly `crawl_units` windows, from the year of `from` or, without it, the year of the oldest play. Finding the oldest play takes two requests: page 1 for the page count, then the last page, whose last item is the oldest play. Both archive under the window `earliest`. A later call finds the years already enqueued and skips the discovery. Trakt has no result cap, so a year never splits. A ratings backfill is one full read.

## Instapaper

Instapaper is the third source: every bookmark across Home, the Archive, and my own folders, with its highlights and the note on each. The tables are shaped so a later feed can select liked bookmarks with their notes in one join.

| Table                   | Columns                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instapaper_bookmarks`  | Bookmark ID, url, title, description, image, author, article published at, saved at, liked, archived, folder ID, progress, progress at, private source, category, tags, deleted at |
| `instapaper_highlights` | Highlight ID, bookmark ID, text, note, position, created at                                                                                                                        |
| `instapaper_folders`    | Folder ID, title, slug, position, public                                                                                                                                           |

#### Access

The sync calls API v2 through `instapaper-api`, Instapaper's TypeScript SDK. Every request carries a bearer token. `INSTAPAPER_ACCESS_TOKEN` is a personal access token generated for my own account on the [Applications page](https://www.instapaper.com/developers/applications). It doesn't expire. The cron skips Instapaper while it is unset.

The SDK hands back parsed JSON that nothing has checked. The Worker gives it a `fetch` that keeps each response's bytes, status, and `Retry-After`. Those bytes go to R2 as received and validate against zod schemas, the same parse a replay runs. The request cap admits each call before the SDK sends it.

#### Change Listing

`GET /bookmarks?since=` returns every bookmark changed since a Unix timestamp across Home, the Archive, and every folder, with `deleted_ids` for those deleted. Changed bookmarks and deleted IDs share a page of up to 500, so the offset advances by both and a short page ends the read. A returned bookmark upserts and clears `deleted_at`. A deleted ID sets `deleted_at`. Nothing in the read writes to the account.

#### Hourly Pass

The pass reads `GET /folders`, then the change listing from five minutes before the `instapaper-bookmarks` watermark, which absorbs clock drift between the Worker and Instapaper. Every bookmark it returned has its highlights unit put back to pending. The watermark takes the pass's start once the listing lands, and until a backfill sets it, the pass is skipped. What the cap leaves drains the bookmarks frontier, then the highlights frontier.

#### Highlights

`GET /bookmarks/{id}/highlights` returns a bookmark's complete highlight list, so a highlight D1 holds that the list omits was deleted. `instapaper-highlights` runs only as frontier units and has no watermark. A read that fails without a limit behind it settles its unit `irreducible`, so one bookmark cannot hold the frontier. The unit goes back to pending when the bookmark next comes back changed.

#### Backfill

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/backfill?kind=instapaper-bookmarks"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER/admin/backfill?kind=instapaper-highlights"
```

A bookmarks backfill reads the folders, then enqueues one unit: the change listing from `since=1`, which covers the whole account. Once it lands, the watermark takes its fetch time, every bookmark it returned has its highlights queued, and the hourly pass takes over. A limit mid-read leaves the unit pending, and the next call reads it again from the first page. A highlights backfill enqueues every bookmark not known to be deleted, one request each. Instapaper has no date windows to crawl, so `from` is ignored.

#### Rate Limit

Instapaper documents a rate limit without a number and answers 429 past it. `RATE_CAP_INSTAPAPER` caps one invocation at 50 requests, cron or backfill. A 429 stops the run with `resumeAt` from `Retry-After`, or an hour when there is none. Instapaper runs record `cost` 0, so the spend ledger stays GitHub's. A highlights backfill of 5,000 bookmarks is 5,000 requests, spread over 100 capped calls.

#### Replay

`replayInstapaper` rebuilds the three tables from `raw/instapaper/`. A deletion on one page can name a bookmark an earlier page upserted, so pages apply in fetch order, and each run stamps its own time to keep that order. A page archived as the failure that stopped its run never reached D1, and the replay skips it.

#### Gaps

- A highlight added, or a note edited, reaches D1 only if it marks the bookmark changed. Otherwise it waits for the next highlights read of that bookmark.
- The backfill's listing restarts from the first page after a limit. At 50 requests of 500 items, one invocation reads 25,000 bookmarks and deleted IDs, so a larger account needs a higher `RATE_CAP_INSTAPAPER` for the backfill to finish.
- The offset pages a set that can change mid-read. A bookmark that shifts across a page boundary can be skipped, and the next pass reads it again because the watermark holds the read's start.
- Each hourly pass archives two pages, the folders and one change page, about 17,500 small objects a year. The bucket stays small in bytes.

Four questions stay open until a live check with the real token: whether `since=1` returns the whole account, whether a new highlight or an edited note marks its bookmark changed, whether a 429 carries `Retry-After`, and what a highlights read answers for a deleted bookmark.

## Visibility

The hub reads public GitHub activity only. `GITHUB_TOKEN` is a classic personal access token with no scopes, so GitHub filters private repositories out before any response reaches the hub. Nothing private from GitHub is stored, archived, or published, and no layer downstream has a redaction path to get wrong.

Instapaper is the exception. Bookmarks, highlights, and notes are private reading history, and they land in D1, the raw bucket, and the lake under `instapaper/v1/`. Nothing publishes them. A feed built from them would need its own decision about what leaves the account.

Totals understate real activity by `restrictedContributionsCount`. Reversing the choice means a token with `repo` scope, a full backfill, and a filter at publish.

## Open Decisions

These are still open.

#### Involvement Queries

`author:` alone undercounts reviews and co-authored work. `involves:` overcounts drive-by mentions. The site's current sync splits the difference, using `involves:` for issues and `is:pr is:merged user:bendrucker -author:bendrucker` for merged pull requests into my own repositories, which counts work other people did that I merged. The set to pick from:

- `author:` and `reviewed-by:` only. Every row is work I did, and the numbers are defensible without a footnote.
- Add `involves:` for issues, which catches issues I participated in but did not open, along with every thread that mentioned me.
- Keep merged-into-my-repositories as its own event type rather than folding it into pull request counts, since it measures maintenance rather than authorship.

Whichever set wins gets documented here, because a homepage number is uninterpretable without knowing which query produced it. A public-only token keeps a wider set from pulling in private repositories.

#### Reusing `packages/github`

- Lift it. The zod schemas, the `nodes()` helper, and the paginated search wrapper exist and are tested, and the `contributionsCollection` query is already written.
- Write a new client. The package is shaped around per-repository aggregation, which is exactly what this project replaces, and every one of its search queries pulls the full repository fragment onto each node.

The zod discipline carries either way: validate at the boundary, infer the type from the schema, never cast.

## Future Work

Out of scope until the feed is live:

- Publishing the lake tables to R2 Data Catalog as Iceberg, following whatever Activity Hub settles on.
- A precomputed stats object regenerated by the nightly build, which would serve most homepage numbers at zero query cost.
- Comment and review-comment bodies, once there is a question that needs the text rather than the count.
- Per-commit history for my own repositories, where the request cost is bounded by repositories I own rather than by every repository I have touched.
