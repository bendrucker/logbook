# Logbook

System of record for personal data pulled from simple APIs on a cron. Two sources: GitHub (pull requests, reviews, issues, and commit counts, published as a code feed to [bendrucker.me](https://github.com/bendrucker/bendrucker.me)) and Instapaper (bookmarks, highlights, and notes), both archived raw in R2. Sibling of [activity-hub](https://github.com/bendrucker/activity-hub), which handles rides and workouts through webhooks and file decoding. GitHub code lives in `src/github/` and the GitHub-shaped `src/sync/`. Instapaper lives in `src/instapaper/` and reuses `sync_state`, `sync_runs`, `crawl_units`, and `recordRun`. See the [README](README.md).

## Stack

Cloudflare Workers (TypeScript), Bun, Wrangler. Storage: D1 (`DB`), R2 (`RAW` for API responses, `LAKE` for Parquet output). `LAKE` is activity-hub's bucket, written under `github/v1/` and `instapaper/v1/` so one DuckDB session can join rides against pull requests. Two cron triggers drive the Worker: an hourly sync and a nightly lake build. Config lives in `wrangler.jsonc`.

`src/index.ts` exports the default handler and nothing else. workerd reads every named export of the entrypoint as a handler and refuses a string. Neither the test suite nor CI catches that, so `bun run dev` is what surfaces it. A constant the handler needs lives in the module it describes.

## Commands

- `bun run typecheck`: `tsc --noEmit` over `src/` and `test/`, then over `scripts/` under its own tsconfig
- `bun run test`: runs `vitest run` (uses `@cloudflare/vitest-pool-workers`, config in `vitest.config.ts`)
- `bun run lint`: runs `oxlint --type-aware --report-unused-disable-directives` over the layers in `lint/`, copied from [bendrucker/claude](https://github.com/bendrucker/claude)
- `bun run backfill <base-url> [kind]`: drives `POST /admin/backfill` to completion, reading `ADMIN_TOKEN` from the environment
- `bun run format` / `bun run format:check`: oxfmt
- `bun run dev`: runs `wrangler dev` for local iteration
- `bun run wrangler <cmd>`: pinned Wrangler binary. Use this over a global `wrangler` install
- `bun run types`: regenerates `worker-configuration.d.ts` from `wrangler.jsonc`

## Deploy

CI runs on every PR and on push to `main` (`.github/workflows/ci.yml`): typecheck, test, lint, format check, a check that `worker-configuration.d.ts` is current, and the `.pre-commit-config.yaml` hooks under `prek`. Those hooks also run locally on every commit, and one of them refuses a commit on `main`.

The `deploy` job applies D1 migrations and runs `wrangler deploy` on push to `main`, gated on `check`. It needs a `CLOUDFLARE_API_TOKEN` repository secret, which is not set. While the secret is empty the job's first step writes a `::notice::` and every later step skips. A merge to `main` then does not fail on a credential no commit can supply. Setting the secret is the only change the workflow needs. Until then, migrations in `migrations/` apply by hand with `bun run wrangler d1 migrations apply DB --remote`, which writes to the live database.

## Cloudflare Configuration

Change Cloudflare resources (R2 buckets, D1 databases, cron triggers, secrets) through `wrangler.jsonc` plus the `wrangler` CLI, never through the Cloudflare dashboard. Dashboard edits drift from what's committed and get silently overwritten on the next deploy.

## Sync

The hourly cron runs one `updated:{since}..{now}` search per event kind plus `contributionsCollection` for the current year. Each search window opens an hour behind that kind's watermark, which covers the lag between a write on GitHub and its appearance in the search index. A range past 1,000 results halves, earliest half first. Kinds run one after another. The first the rate budget refuses ends the invocation instead of the other two spending their way to the same discovery.

The budget lives in `src/sync/budget.ts`: a floor on GitHub's reported `remaining`, a share per rate window, and a cap per invocation, set by the `RATE_*` vars in `wrangler.jsonc`. It checks each request before it goes out. The spend ledger is the sum of `sync_runs.cost` over runs started in the current window. A refusal or a GitHub secondary limit (`SecondaryRateLimited`) ends the run like any other failure but reports `resumeAt`, the instant worth waiting for.

A watermark is an ISO instant meaning synced through, and it moves only after every page is in R2 and every row is in D1. It moves forward only. A backfill of 2013 cannot rewind a caught-up kind. A kind with no watermark is skipped, because anchoring at now would declare the whole history synced.

Backfill sets the first watermark and fills what the cron never saw:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$WORKER/admin/backfill?kind=pr-authored&from=2012-12"
```

One call enqueues the kind's windows from `from` onward in the `crawl_units` frontier (months for search, years for `contributions` and the three connection kinds) and drains them until the rate budget stops it. It answers with the count still `pending`, any `irreducible` windows, and `resumeAt` when a limit stopped it. A window already in the frontier keeps its status, so repeating the call resumes rather than refetches. A truncated window splits down to hours: contributions and connection windows down the calendar, search months through halving day ranges such as `2026-08-01--2026-08-15`. The hourly cron drains leftover share after its own work. 2012-12 is the earliest month that can match.

`issue-contributions`, `pr-contributions`, and `review-contributions` page the cursor connections on `contributionsCollection`, which list what GitHub counts as a contribution, including issues search hides in repositories that later turned Issues off. They upsert into the same event tables as search, archive under `raw/contribution-events/{event kind}/{window}/`, and run only as frontier units, so they have no watermark. A unit reads at most ten pages. One that holds more, or reads fewer nodes than the connection's `totalCount`, splits. Review nodes on the login's own pull requests are dropped, matching migration `0006`. The contributions cross-check reads the year's archived connection pages to name the node IDs behind an issue or pull request gap and to count own-PR reviews.

`bun run backfill` repeats the call until nothing is pending, one line printed per call, and sleeps until `resumeAt` when the route reports one. Backfill requests go out at least two seconds apart. Naming no kind walks every kind in `SYNC_KINDS` in order. It stops on the first non-2xx and on a window the route reports as failed. Rerunning it retries that window.

## Instapaper

The hourly cron runs Instapaper after GitHub settles, independently of it: `folders/list`, then one delta listing per folder (Unread, Archive, each user folder, Starred) sending D1's bookmarks as `have=id:hash`, never with progress, which Instapaper would write back to the account. `delete_ids` mark bookmarks `unlisted_at` or unstar them. Returned bookmarks requeue their `instapaper-highlights` units, and leftover cap drains both frontiers. The watermark gates the pass until a backfill has read every folder. `RATE_CAP_INSTAPAPER` caps requests per invocation, and error 1040 reports `resumeAt`. Instapaper runs record `cost` 0 so the spend ledger stays GitHub's. Pages archive under `raw/instapaper/{kind}/{window}/{fetched_at}/{page}.json`, with the listing mode and `have` size in R2 custom metadata, and `replayInstapaper` applies them in fetch order. The listing reaches only the newest 500 per folder. [docs/design.md](docs/design.md#gaps) lists the gaps.

## Secrets

Worker secrets are set with `wrangler secret put`, never committed. `wrangler dev` reads them from `.dev.vars`, which is gitignored. `.dev.vars.example` lists the names with empty values. Locally `.dev.vars` is a 1Password Environment mount (`logbook`), a FIFO. Never write a plain file there or print it. `wrangler types` reads it, so regenerate `worker-configuration.d.ts` from a copy of `wrangler.jsonc` in a directory without one. The four `INSTAPAPER_*` secrets sign every Instapaper request. The access token and secret come from `bun run instapaper:login`, which prompts for the password and never stores it. `GITHUB_TOKEN` signs every GraphQL and search request. It is a classic personal access token with no scopes, so the hub sees public activity only. Granting it `repo` scope would pull private repositories into the archive and the feed, which the [design](docs/design.md#visibility) rules out. `ADMIN_TOKEN` guards `/admin/sync`, `/admin/backfill`, and `/admin/lake`, and all three answer 404 while it is unset so an unconfigured deployment has no admin surface. Public, non-sensitive identifiers belong in `wrangler.jsonc` as `vars`: `GITHUB_LOGIN` is whose history the hub reads, and the `RATE_*` vars are the rate budget.

## Lake

`scheduled` picks the nightly build over the sync by matching `controller.cron` against `LAKE_CRON` in `src/lake/build.ts`, which a test holds against the triggers `wrangler.jsonc` configures. An expression that changes in one place and not the other leaves the lake unbuilt and reports nothing. The [README](README.md#lake) covers what the build guarantees and how to run it by hand.
