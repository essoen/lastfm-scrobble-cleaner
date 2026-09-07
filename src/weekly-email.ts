import {
  formatDate,
  type DailySummaryRecord,
  type DeferredItem,
  type DeletedItem,
  type FailedItem,
  type RunSummary,
} from "./summary-store.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Distinct days an item may stay deferred before it's called stuck. */
const STUCK_AFTER_DAYS = 3;

export function weekStart(sunday: Date): Date {
  const d = new Date(sunday.getTime());
  d.setUTCDate(d.getUTCDate() - 6);
  return d;
}

interface ScrobbleRef {
  artist: string;
  track: string;
  timestamp: string;
  uts?: string;
}

interface Occurrence<T> {
  key: string;
  item: T;
  /** Dates whose summary listed this scrobble, ascending. */
  days: string[];
}

/**
 * Stable identity for a scrobble across days.
 *
 * The 168h fetch window means an undeleted duplicate is re-detected every day,
 * so the same scrobble shows up in several daily summaries. `uts` collapses
 * those into one line. Records written before uts was stored fall back to a
 * per-day, per-position key: it never merges across days (so old records read
 * exactly as they did before), but it also never merges same-minute siblings,
 * which display timestamps alone would wrongly collapse.
 */
function keyOf(item: ScrobbleRef, date: string, index: number): string {
  return item.uts
    ? `uts:${item.uts}`
    : `legacy:${date}:${index}:${item.artist}:${item.track}:${item.timestamp}`;
}

function collect<T extends ScrobbleRef>(
  records: DailySummaryRecord[],
  pick: (summary: RunSummary) => T[] | undefined,
): Occurrence<T>[] {
  const byKey = new Map<string, { item: T; days: Set<string> }>();

  for (const record of records) {
    (pick(record.summary) ?? []).forEach((item, index) => {
      const key = keyOf(item, record.date, index);
      const existing = byKey.get(key);
      if (existing) existing.days.add(record.date);
      else byKey.set(key, { item, days: new Set([record.date]) });
    });
  }

  return [...byKey.entries()].map(([key, { item, days }]) => ({
    key,
    item,
    days: [...days].sort(),
  }));
}

/** "Seen: 4 days" line, only when the scrobble recurred across the week. */
function seenLine(days: string[]): string | null {
  if (days.length < 2) return null;
  return `    Seen: ${days.length} days (${days[0]} to ${days[days.length - 1]})`;
}

function pushSection<T extends ScrobbleRef>(
  lines: string[],
  heading: string,
  occurrences: Occurrence<T>[],
  label: (item: T, days: string[]) => string,
  opts: { note?: string; detail?: (item: T) => string } = {},
): void {
  if (occurrences.length === 0) return;
  lines.push("", heading);
  if (opts.note) lines.push(`  (${opts.note})`);
  for (const { item, days } of occurrences) {
    lines.push(`  [${label(item, days)}] ${item.artist} - ${item.track}`);
    lines.push(`    Time: ${item.timestamp}`);
    const seen = seenLine(days);
    if (seen) lines.push(seen);
    if (opts.detail) lines.push(`    Detail: ${opts.detail(item)}`);
  }
}

export function buildWeeklyEmail(
  endSunday: Date,
  records: DailySummaryRecord[],
): { subject: string; message: string } {
  const start = weekStart(endSunday);
  const startStr = formatDate(start);
  const endStr = formatDate(endSunday);

  const totals = records.reduce(
    (acc, r) => {
      acc.scrobblesScanned += r.summary.scrobblesScanned;
      acc.sessionsFound += r.summary.sessionsFound;
      acc.duplicatesFound += r.summary.duplicatesFound;
      acc.deleted += r.summary.deleted;
      return acc;
    },
    { scrobblesScanned: 0, sessionsFound: 0, duplicatesFound: 0, deleted: 0 },
  );

  // Deletions carry their run's dryRun flag so a dry-run week still reads as
  // "would delete" after the per-day records are merged.
  const deletions = collect<DeletedItem & { dryRun: boolean }>(records, (s) =>
    s.deletedItems.map((item) => ({ ...item, dryRun: s.dryRun })),
  );
  const deferrals = collect<DeferredItem>(records, (s) => s.deferredItems);
  const failures = collect<FailedItem>(records, (s) => s.failedItems);

  const uniqueDuplicates = new Set(
    [...deletions, ...deferrals, ...failures].map((o) => o.key),
  ).size;

  // A scrobble deferred or failed on one run and deleted on a later one is a
  // success story, not an open item — the deletion list already reports it.
  const deletedKeys = new Set(deletions.map((o) => o.key));
  const openDeferrals = deferrals.filter((o) => !deletedKeys.has(o.key));
  const openFailures = failures.filter((o) => !deletedKeys.has(o.key));
  const selfHealed =
    deferrals.length - openDeferrals.length + failures.length - openFailures.length;

  const lines: string[] = [
    "Last.fm Scrobble Cleaner - Weekly Summary",
    "=========================================",
    `Week: ${startStr} to ${endStr}`,
    "",
    "Totals",
    `  Scrobbles scanned: ${totals.scrobblesScanned}`,
    `  Sessions found:    ${totals.sessionsFound}`,
    `  Duplicates found:  ${totals.duplicatesFound} (re-counted each day one is still present)`,
    `  Unique duplicates: ${uniqueDuplicates}`,
    `  Deleted:           ${totals.deleted}`,
    `  Deferred:          ${openDeferrals.length} still queued`,
    `  Failed:            ${openFailures.length}`,
    `  Days with data:    ${records.length}/7`,
    "",
    "Per day",
  ];

  const byDate = new Map(records.map((r) => [r.date, r]));
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const key = formatDate(d);
    const name = DAY_NAMES[d.getUTCDay()];
    const rec = byDate.get(key);
    if (!rec) {
      lines.push(`  ${name} ${key}: no data`);
      continue;
    }
    const s = rec.summary;
    const flags: string[] = [];
    if (s.dryRun) flags.push("dry run");
    if (s.circuitBreakerTriggered) flags.push("circuit breaker");
    const tail = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    const deferred = s.deferred ?? 0;
    lines.push(
      `  ${name} ${key}: scanned=${s.scrobblesScanned}, duplicates=${s.duplicatesFound}, deleted=${s.deleted}${deferred > 0 ? `, deferred=${deferred}` : ""}${s.failed > 0 ? `, failed=${s.failed}` : ""}${tail}`,
    );
  }

  if (selfHealed > 0) {
    lines.push(
      "",
      `Self-healed: ${selfHealed} scrobble(s) deferred or failed on one run and deleted on a later one.`,
    );
  }

  if (
    deletions.length === 0 &&
    deferrals.length === 0 &&
    failures.length === 0
  ) {
    lines.push("", "No duplicates found this week. Your scrobbles are clean!");
  }

  pushSection(lines, "Deletions this week", deletions, (item) =>
    item.dryRun ? "would delete" : item.reason,
  );

  pushSection(
    lines,
    "Deferred (still queued)",
    openDeferrals,
    (item, days) =>
      days.length >= STUCK_AFTER_DAYS
        ? `${item.reason} - stuck`
        : item.reason,
    {
      note: "rate-limited or not attempted; a later run re-detects and retries these",
    },
  );

  pushSection(
    lines,
    "Failed (needs attention)",
    openFailures,
    (item) => item.reason,
    { detail: (item) => item.detail },
  );

  const subject = `Last.fm Cleaner: Weekly summary (${startStr} to ${endStr})`;
  return { subject, message: lines.join("\n") };
}
