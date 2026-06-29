import { loadConfig } from "./config.js";
import { createClient, type Scrobble } from "./lastfm-client.js";
import { createWebClient, DeleteFailedError } from "./lastfm-web.js";
import { detectDuplicates } from "./detect-duplicates.js";
import { createDurationCache } from "./duration-cache.js";
import {
  createSummaryStore,
  formatDate,
  type DailySummaryRecord,
  type RunSummary,
} from "./summary-store.js";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekStart(sunday: Date): Date {
  const d = new Date(sunday.getTime());
  d.setUTCDate(d.getUTCDate() - 6);
  return d;
}

function buildWeeklyEmail(
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
      acc.failed += r.summary.failed;
      return acc;
    },
    { scrobblesScanned: 0, sessionsFound: 0, duplicatesFound: 0, deleted: 0, failed: 0 },
  );

  const lines: string[] = [
    "Last.fm Scrobble Cleaner - Weekly Summary",
    "=========================================",
    `Week: ${startStr} to ${endStr}`,
    "",
    "Totals",
    `  Scrobbles scanned: ${totals.scrobblesScanned}`,
    `  Sessions found:    ${totals.sessionsFound}`,
    `  Duplicates found:  ${totals.duplicatesFound}`,
    `  Deleted:           ${totals.deleted}`,
    `  Failed:            ${totals.failed}`,
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
    lines.push(
      `  ${name} ${key}: scanned=${s.scrobblesScanned}, duplicates=${s.duplicatesFound}, deleted=${s.deleted}${s.failed > 0 ? `, failed=${s.failed}` : ""}${tail}`,
    );
  }

  const allDeletions = records.flatMap((r) =>
    r.summary.deletedItems.map((item) => ({ date: r.date, dryRun: r.summary.dryRun, ...item })),
  );

  if (allDeletions.length === 0) {
    lines.push("", "No duplicates found this week. Your scrobbles are clean!");
  } else {
    lines.push("", "Deletions this week");
    for (const item of allDeletions) {
      const tag = item.dryRun ? "would delete" : item.reason;
      lines.push(`  [${tag}] ${item.artist} - ${item.track}`);
      lines.push(`    Time: ${item.timestamp}`);
    }
  }

  const allFailures = records.flatMap((r) =>
    (r.summary.failedItems ?? []).map((item) => ({ date: r.date, ...item })),
  );

  if (allFailures.length > 0) {
    lines.push("", "Failed deletions this week");
    for (const item of allFailures) {
      lines.push(`  [${item.reason}] ${item.artist} - ${item.track}`);
      lines.push(`    Time: ${item.timestamp}`);
      lines.push(`    Detail: ${item.detail}`);
    }
  }

  const subject = `Last.fm Cleaner: Weekly summary (${startStr} to ${endStr})`;
  return { subject, message: lines.join("\n") };
}

async function finalizeRun(
  now: Date,
  summary: RunSummary,
  tableName: string | undefined,
  topicArn: string | undefined,
): Promise<void> {
  if (!tableName) {
    console.warn("DURATION_TABLE not set; skipping summary persistence.");
    return;
  }
  const store = createSummaryStore(tableName);
  await store.put(now, summary);
  console.log(`Persisted daily summary for ${formatDate(now)}.`);

  if (now.getUTCDay() !== 0) {
    console.log("Not Sunday — no weekly email this run.");
    return;
  }
  if (!topicArn) {
    console.warn("SNS_TOPIC_ARN not set; skipping weekly email.");
    return;
  }

  const records = await store.getLastSevenDays(now);
  console.log(`Found ${records.length}/7 daily summaries for the week.`);

  const { subject, message } = buildWeeklyEmail(now, records);
  const sns = new SNSClient({});
  await sns.send(
    new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }),
  );
  console.log("Weekly summary email sent.");
}

export async function handler(): Promise<void> {
  const config = await loadConfig(process.env as Record<string, string>);
  const snsTopicArn = process.env.SNS_TOPIC_ARN;
  const stateTable = process.env.DURATION_TABLE;
  const apiClient = createClient(config.apiKey, config.apiSecret);
  const webClient = createWebClient(config.username);

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const from = nowSec - config.fetchWindowHours * 3600;

  console.log(`Fetching scrobbles from ${new Date(from * 1000).toISOString()} to now`);
  console.log(`Dry run: ${config.dryRun}`);

  const allScrobbles: Scrobble[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await apiClient.getRecentTracks({
      user: config.username,
      from,
      to: nowSec,
      limit: 200,
      page,
    });
    allScrobbles.push(...result.tracks);
    totalPages = result.totalPages;
    page++;
  }

  console.log(`Fetched ${allScrobbles.length} scrobbles across ${totalPages} page(s)`);

  const summary: RunSummary = {
    scrobblesScanned: allScrobbles.length,
    sessionsFound: 0,
    duplicatesFound: 0,
    deleted: 0,
    failed: 0,
    dryRun: config.dryRun,
    deletedItems: [],
    failedItems: [],
    circuitBreakerTriggered: false,
  };

  if (allScrobbles.length === 0) {
    console.log("No scrobbles in window. Done.");
    await finalizeRun(now, summary, stateTable, snsTopicArn);
    return;
  }

  const cache = createDurationCache(apiClient);

  const result = await detectDuplicates(
    allScrobbles,
    apiClient,
    config.sessionGapSeconds,
    (artist, track) => cache.get(artist, track),
  );

  summary.sessionsFound = result.sessionCount;
  summary.duplicatesFound = result.flagged.length;

  console.log(
    `Found ${result.flagged.length} duplicate(s) across ${result.sessionCount} session(s)`,
  );

  if (result.flagged.length === 0) {
    console.log("No duplicates found. Done.");
    await finalizeRun(now, summary, stateTable, snsTopicArn);
    return;
  }

  for (const f of result.flagged) {
    console.log(
      `  [${f.reason}] ${f.scrobble.artist["#text"]} — ${f.scrobble.name} @ ${f.scrobble.date["#text"]}`,
    );
  }

  if (result.flagged.length > config.maxDeletionsPerRun) {
    console.warn(
      `Circuit breaker: ${result.flagged.length} duplicates exceed max ${config.maxDeletionsPerRun}. Only deleting first ${config.maxDeletionsPerRun}.`,
    );
    summary.circuitBreakerTriggered = true;
  }

  const toDelete = result.flagged.slice(0, config.maxDeletionsPerRun);

  for (const f of toDelete) {
    summary.deletedItems.push({
      artist: f.scrobble.artist["#text"],
      track: f.scrobble.name,
      reason: f.reason,
      timestamp: f.scrobble.date["#text"],
    });
  }

  if (config.dryRun) {
    console.log(`DRY RUN: Would delete ${toDelete.length} scrobble(s). No action taken.`);
    await finalizeRun(now, summary, stateTable, snsTopicArn);
    return;
  }

  console.log("Logging in to Last.fm web...");
  await webClient.login(config.username, config.password);

  // Base spacing between deletions, plus escalating backoff when rate-limited.
  const baseDelayMs = config.deletionDelayMs;
  const RATE_LIMIT_BASE_BACKOFF_MS = 15_000;
  const RATE_LIMIT_MAX_BACKOFF_MS = 90_000;
  const MAX_RATE_LIMIT_RETRIES = 3;
  // When the run hits a wall of rate limits (AWS egress IP is being blocked),
  // there's no point grinding through the rest — stop and let a future run
  // (which re-detects the same duplicates within the fetch window) retry.
  let stop = false;

  for (const f of toDelete) {
    if (stop) break;
    const artist = f.scrobble.artist["#text"];
    const track = f.scrobble.name;

    for (let attempt = 0; ; ) {
      try {
        await webClient.deleteScrobble({
          artist,
          track,
          timestamp: parseInt(f.scrobble.date.uts, 10),
        });
        summary.deleted++;
        console.log(`  Deleted: ${artist} — ${track}`);
        break;
      } catch (err: any) {
        const isStructured = err instanceof DeleteFailedError;

        // Rate-limited: actually wait, then retry the SAME scrobble.
        if (
          isStructured &&
          err.reason === "http_rate_limited" &&
          attempt < MAX_RATE_LIMIT_RETRIES
        ) {
          attempt++;
          // Last.fm sends a useless `Retry-After: 0`, so only honour positive
          // values; otherwise back off exponentially (capped to stay within the
          // Lambda timeout).
          const retry =
            err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : null;
          const backoffMs = Math.min(
            retry ?? RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 1),
            RATE_LIMIT_MAX_BACKOFF_MS,
          );
          console.log(
            `  Rate-limited (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES}). Backing off ${Math.round(backoffMs / 1000)}s...`,
          );
          await sleep(backoffMs);
          continue;
        }

        // Give up on this scrobble.
        summary.failed++;
        const reason = isStructured ? err.reason : "exception";
        const detail = isStructured
          ? `status=${err.status} set-cookie=${err.setCookiePresent} body="${err.bodySnippet}"`
          : (err?.message ?? String(err));
        summary.failedItems.push({
          artist,
          track,
          timestamp: f.scrobble.date["#text"],
          reason,
          detail,
        });
        console.error(`  Failed [${reason}]: ${artist} — ${track}: ${detail}`);

        if (isStructured && err.reason === "http_403") {
          console.log("  Re-authenticating...");
          try {
            await webClient.login(config.username, config.password);
          } catch {
            console.error("  Re-authentication failed. Stopping.");
            stop = true;
          }
        } else if (isStructured && err.reason === "http_rate_limited") {
          console.error(
            "  Still rate-limited after retries. Stopping; remaining scrobbles will be retried on a future run.",
          );
          stop = true;
        }
        break;
      }
    }

    if (!stop) await randomDelay(baseDelayMs, baseDelayMs * 3);
  }

  console.log(`Done. Deleted: ${summary.deleted}, Failed: ${summary.failed}`);

  await finalizeRun(now, summary, stateTable, snsTopicArn);
}
