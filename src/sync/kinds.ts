import type { EventKind } from "../github/windows";

// The contribution connections list the same events the searches find, from
// GitHub's own count rather than its search index.
export type ContributionEventsKind =
  | "issue-contributions"
  | "pr-contributions"
  | "review-contributions";

// The three search kinds come from the extraction client's own union, so a kind
// added there breaks byKind below until this module covers it too.
export type SyncKind = EventKind | "contributions" | ContributionEventsKind;

export const SEARCH_KINDS = [
  "pr-authored",
  "pr-reviewed",
  "issue",
] as const satisfies readonly EventKind[];

export const SYNC_KINDS = [
  "pr-authored",
  "pr-reviewed",
  "issue",
  "contributions",
  "issue-contributions",
  "pr-contributions",
  "review-contributions",
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
  };
}
