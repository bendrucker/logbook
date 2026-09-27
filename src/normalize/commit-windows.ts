import { splitContributions } from "../github/calendar";
import { contributionsTruncated } from "../github/contributions";
import type { ContributionsCollection } from "../github/schema";
import type { CommitDay, Repository } from "../store";
import { type ContributionRows, contributionRows } from "./rows";

interface ArchivedWindow {
  fetchedAt: string;
  commitDays: readonly CommitDay[];
  truncated: boolean;
}

export interface CombinedWindows {
  rows: ContributionRows;
  // Some window under the root dropped data that no archived narrower window
  // recovers.
  truncated: boolean;
}

// A year's archived windows, folded in one response at a time. Each keeps only
// the rows the combination reads, so the collection it came from can go as
// soon as it is added.
export class ArchivedWindows {
  readonly #windows = new Map<string, ArchivedWindow>();
  readonly #repositories = new Map<string, Repository>();

  add(window: string, collection: ContributionsCollection, fetchedAt: string): void {
    const rows = contributionRows(collection, fetchedAt);
    this.#windows.set(window, {
      fetchedAt,
      commitDays: rows.commitDays,
      truncated: contributionsTruncated(collection),
    });
    // The newest fetch of a repository names its row, and of two windows
    // fetched together the one added later does.
    for (const repository of rows.repositories) {
      const held = this.#repositories.get(repository.id);
      if (held === undefined || held.fetchedAt <= repository.fetchedAt) {
        this.#repositories.set(repository.id, repository);
      }
    }
  }

  // `root` and the windows under it form the tree the crawl split them into,
  // with the newest fetch standing for each. A window from a day up lists whole
  // days, so its children hold the same count for a repository's day and any
  // of them is the day's count. A window narrower than a day counts part of
  // each day, so its siblings add up to the day. Taking the larger of a
  // window's own count and its children's sum covers both: a parent that
  // listed the day wins over children still partly fetched, and children that
  // recovered a repository the parent dropped supply it.
  combine(root: string): CombinedWindows {
    const archived = this.#windows;
    const fetches = [...archived.values()].map((window) => window.fetchedAt).toSorted();
    const fallback = new Date(fetches.at(-1) ?? 0);

    // A window clipped at the instant it was fetched split into the children
    // that had started by then.
    const children = (key: string): string[] => {
      const at = archived.get(key)?.fetchedAt;
      return splitContributions(key, at === undefined ? fallback : new Date(at)).map(
        (child) => child.key,
      );
    };

    return {
      rows: {
        repositories: [...this.#repositories.values()],
        commitDays: [...totals(root, archived, children).values()],
      },
      truncated: truncated(root, archived, children),
    };
  }
}

type Children = (key: string) => string[];

function totals(
  key: string,
  archived: ReadonlyMap<string, ArchivedWindow>,
  children: Children,
): Map<string, CommitDay> {
  const summed = new Map<string, CommitDay>();
  for (const child of children(key).filter((each) => archived.has(each))) {
    for (const [id, day] of totals(child, archived, children)) {
      const earlier = summed.get(id)?.commitCount ?? 0;
      summed.set(id, { ...day, commitCount: earlier + day.commitCount });
    }
  }

  for (const day of archived.get(key)?.commitDays ?? []) {
    const id = `${day.repositoryId}/${day.day}`;
    const recovered = summed.get(id)?.commitCount ?? 0;
    summed.set(id, { ...day, commitCount: Math.max(day.commitCount, recovered) });
  }

  return summed;
}

function truncated(
  key: string,
  archived: ReadonlyMap<string, ArchivedWindow>,
  children: Children,
): boolean {
  const window = archived.get(key);
  if (window !== undefined && !window.truncated) {
    return false;
  }

  const narrower = children(key);
  return (
    narrower.length === 0 ||
    narrower.some((child) => !archived.has(child) || truncated(child, archived, children))
  );
}
