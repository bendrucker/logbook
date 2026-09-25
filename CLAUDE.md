# Logbook

System of record for personal data pulled from simple APIs on a cron. GitHub is the only source so far: pull requests, reviews, issues, and commit counts, archived raw in R2 and published as a code feed to [bendrucker.me](https://github.com/bendrucker/bendrucker.me). Sibling of [activity-hub](https://github.com/bendrucker/activity-hub), which handles rides and workouts through webhooks and file decoding. Only polled API sources belong here. Don't generalize the code for a second source until one lands. See the [README](README.md).

## Stack

Cloudflare Workers (TypeScript), Bun, Wrangler. Storage: D1 (`DB`, named `code-hub` from before the rename), R2 (`RAW` for API responses, `LAKE` for Parquet output). `LAKE` is activity-hub's bucket, written under a `github/` prefix so one DuckDB session can join rides against pull requests. Two cron triggers drive the Worker: an hourly sync and a nightly lake build. Config lives in `wrangler.jsonc`.

`src/index.ts` exports the default handler and nothing else. workerd reads every named export of the entrypoint as a handler and refuses a string. Neither the test suite nor CI catches that, so `bun run dev` is what surfaces it. A constant the handler needs lives in the module it describes.

## Commands

- `bun run typecheck`: `tsc --noEmit` over `src/` and `test/`, then over `scripts/` under its own tsconfig
- `bun run test`: runs `vitest run` (uses `@cloudflare/vitest-pool-workers`, config in `vitest.config.ts`)
- `bun run lint`: runs `oxlint --report-unused-disable-directives && ast-grep scan`
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

The hourly cron runs one `updated:>` search per event kind plus `contributionsCollection` for the current year. Each search window opens an hour behind that kind's watermark, which covers the lag between a write on GitHub and its appearance in the search index. Kinds run one after another. The first to reach the rate-limit floor ends the invocation instead of the other two spending their way to the same discovery.

A watermark is an ISO instant meaning synced through, and it moves only after every page is in R2 and every row is in D1. It moves forward only. A backfill of 2013 cannot rewind a caught-up kind. A kind with no watermark is skipped, because anchoring at now would declare the whole history synced.

Backfill sets the first watermark and fills what the cron never saw:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$WORKER/admin/backfill?kind=pr-authored&from=2012-12"
```

One call walks `BACKFILL_WINDOWS` monthly windows and answers with `next`, which is the `from` for the call after it and null once the walk reaches the present. `kind=contributions` walks the years `contributionYears` reports rather than months, and reads the year out of `from`. 2012-12 is the earliest month that can match.

`bun run backfill` feeds `next` back in until the route reports null, one line printed per call. Naming no kind walks all four in order. It stops on the first non-2xx and on a window the route reports as failed, printing the `--from` that resumes there.

## Secrets

Worker secrets are set with `wrangler secret put`, never committed. `wrangler dev` reads them from `.dev.vars`, which is gitignored. `.dev.vars.example` lists the names with empty values. `GITHUB_TOKEN` signs every GraphQL and search request, and it sees private repositories, so what the feed publishes about them is a decision the ingest path owns. `ADMIN_TOKEN` guards `/admin/sync`, `/admin/backfill`, and `/admin/lake`, and all three answer 404 while it is unset so an unconfigured deployment has no admin surface. Public, non-sensitive identifiers belong in `wrangler.jsonc` as `vars`: `GITHUB_LOGIN` is whose history the hub reads, and `BACKFILL_WINDOWS` is how many windows one backfill call walks.

## Lake

`scheduled` picks the nightly build over the sync by matching `controller.cron` against `LAKE_CRON` in `src/lake/build.ts`, which a test holds against the triggers `wrangler.jsonc` configures. An expression that changes in one place and not the other leaves the lake unbuilt and reports nothing. The [README](README.md#lake) covers what the build guarantees and how to run it by hand.
