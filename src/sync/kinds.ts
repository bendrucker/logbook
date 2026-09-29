import type { EventKind } from "../github/windows";

// The contribution connections list the same events the searches find, from
// GitHub's own count rather than its search index.
export type ContributionEventsKind =
  | "issue-contributions"
  | "pr-contributions"
  | "review-contributions";

// The three search kinds come from the extraction client's own union, so a kind
// added there breaks byKind below until this module covers it too.
export type GitHubKind = EventKind | "contributions" | ContributionEventsKind;

export type TraktKind = "trakt-history" | "trakt-ratings";

export type InstapaperKind = "instapaper-bookmarks" | "instapaper-highlights";

export type SyncKind = GitHubKind | TraktKind | InstapaperKind;

export const SEARCH_KINDS = [
  "pr-authored",
  "pr-reviewed",
  "issue",
] as const satisfies readonly EventKind[];

// Every GitHub kind spends from one token's point budget, which the Trakt and
// Instapaper kinds never touch.
export const GITHUB_KINDS = [
  "pr-authored",
  "pr-reviewed",
  "issue",
  "contributions",
  "issue-contributions",
  "pr-contributions",
  "review-contributions",
] as const satisfies readonly GitHubKind[];

export const TRAKT_KINDS = [
  "trakt-history",
  "trakt-ratings",
] as const satisfies readonly TraktKind[];

// Bookmarks first, since a highlights backfill enqueues the bookmarks D1 holds.
export const INSTAPAPER_KINDS = [
  "instapaper-bookmarks",
  "instapaper-highlights",
] as const satisfies readonly InstapaperKind[];

export const SYNC_KINDS = [
  ...GITHUB_KINDS,
  ...TRAKT_KINDS,
  ...INSTAPAPER_KINDS,
] as const satisfies readonly SyncKind[];

// The event kind a connection's nodes archive and normalize as, which is the
// search kind finding the same events.
export const CONTRIBUTION_EVENTS: Record<ContributionEventsKind, EventKind> = {
  "issue-contributions": "issue",
  "pr-contributions": "pr-authored",
  "review-contributions": "pr-reviewed",
};

export function isContributionEventsKind(kind: SyncKind): kind is ContributionEventsKind {
  return kind in CONTRIBUTION_EVENTS;
}

export function isTraktKind(kind: SyncKind): kind is TraktKind {
  return TRAKT_KINDS.some((each) => each === kind);
}

export function isInstapaperKind(kind: SyncKind): kind is InstapaperKind {
  return INSTAPAPER_KINDS.some((each) => each === kind);
}

// Spelling the keys out is what lets the compiler check them: a record missing
// one fails to satisfy its own return type.
export function byKind<Value>(value: (kind: SyncKind) => Value): Record<SyncKind, Value> {
  return {
    "pr-authored": value("pr-authored"),
    "pr-reviewed": value("pr-reviewed"),
    issue: value("issue"),
    contributions: value("contributions"),
    "issue-contributions": value("issue-contributions"),
    "pr-contributions": value("pr-contributions"),
    "review-contributions": value("review-contributions"),
    "trakt-history": value("trakt-history"),
    "trakt-ratings": value("trakt-ratings"),
    "instapaper-bookmarks": value("instapaper-bookmarks"),
    "instapaper-highlights": value("instapaper-highlights"),
  };
}
