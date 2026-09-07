import { loadConfig } from "./config.js";
import { createClient, type Scrobble } from "./lastfm-client.js";
import { createWebClient, DeleteFailedError } from "./lastfm-web.js";
import { detectDuplicates, type FlaggedDuplicate } from "./detect-duplicates.js";
import { createDurationCache } from "./duration-cache.js";
import {
  createSummaryStore,
  formatDate,
  type DeferredItem,
  type RunSummary,
} from "./summary-store.js";
import { buildWeeklyEmail } from "./weekly-email.js";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

/** RunSummary with the optional fields this run always fills in. */
type WorkingSummary = RunSummary & {
  deferred: number;
  deferredItems: DeferredItem[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

async function finalizeRun(
  now: Date,
  summary: WorkingSummary,
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

  const summary: WorkingSummary = {
    scrobblesScanned: allScrobbles.length,
    sessionsFound: 0,
    duplicatesFound: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    dryRun: config.dryRun,
    deletedItems: [],
    failedItems: [],
    deferredItems: [],
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

  // Identity of a flagged scrobble as it goes into the summary. `uts` is what
  // lets the weekly email tell same-minute siblings apart and merge the same
  // scrobble re-detected on later days.
  const refOf = (f: FlaggedDuplicate) => ({
    artist: f.scrobble.artist["#text"],
    track: f.scrobble.name,
    timestamp: f.scrobble.date["#text"],
    uts: f.scrobble.date.uts,
  });

  /** Not deleted, not a failure: expected to be retried by a later run. */
  const defer = (f: FlaggedDuplicate, reason: string) => {
    summary.deferredItems.push({ ...refOf(f), reason });
    summary.deferred++;
  };

  if (config.dryRun) {
    for (const f of toDelete) {
      summary.deletedItems.push({ ...refOf(f), reason: f.reason });
    }
    console.log(`DRY RUN: Would delete ${toDelete.length} scrobble(s). No action taken.`);
    await finalizeRun(now, summary, stateTable, snsTopicArn);
    return;
  }

  console.log("Logging in to Last.fm web...");
  await webClient.login(config.username, config.password);

  // A plain page view before the first delete: it looks like real browser
  // navigation to the WAF, and it tells us up front whether this invocation's
  // egress IP is being blocked — cheaper than discovering it via backoff.
  if (!(await webClient.probe())) {
    console.warn(
      "IP appears blocked (rate-limit page on a plain page view) — deferring to next run.",
    );
    for (const f of toDelete) defer(f, "ip_blocked");
    await finalizeRun(now, summary, stateTable, snsTopicArn);
    return;
  }

  // Base spacing between deletions, plus escalating backoff when rate-limited.
  const baseDelayMs = config.deletionDelayMs;
  const RATE_LIMIT_BASE_BACKOFF_MS = 15_000;
  const RATE_LIMIT_MAX_BACKOFF_MS = 45_000;
  // Two short waits cover a genuine transient throttle. Longer grinding does
  // not help: when the egress IP itself is blocked, only a new invocation
  // (with a new IP) clears it.
  const MAX_RATE_LIMIT_RETRIES = 2;
  // When the run hits a wall of rate limits, there's no point continuing —
  // stop and let a future run (which re-detects the same duplicates within the
  // fetch window) retry.
  let stop = false;

  for (let i = 0; i < toDelete.length; i++) {
    const f = toDelete[i];
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
        summary.deletedItems.push({ ...refOf(f), reason: f.reason });
        console.log(`  Deleted: ${artist} — ${track}`);
        break;
      } catch (err: any) {
        const isStructured = err instanceof DeleteFailedError;
        const rateLimited = isStructured && err.reason === "http_rate_limited";

        // Rate-limited: actually wait, then retry the SAME scrobble.
        if (rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
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

        if (rateLimited) {
          // Not a failure — the IP is throttled right now, and the next run
          // re-detects this scrobble inside the fetch window.
          defer(f, "rate_limited");
          console.warn(
            `  Deferred (rate-limited): ${artist} — ${track}. Stopping; a future run will retry.`,
          );
          stop = true;
          break;
        }

        // Genuine failure — give up on this scrobble.
        summary.failed++;
        const reason = isStructured ? err.reason : "exception";
        const detail = isStructured
          ? `status=${err.status} set-cookie=${err.setCookiePresent} body="${err.bodySnippet}"`
          : (err?.message ?? String(err));
        summary.failedItems.push({ ...refOf(f), reason, detail });
        console.error(`  Failed [${reason}]: ${artist} — ${track}: ${detail}`);

        if (isStructured && err.reason === "http_403") {
          console.log("  Re-authenticating...");
          try {
            await webClient.login(config.username, config.password);
          } catch {
            console.error("  Re-authentication failed. Stopping.");
            stop = true;
          }
        }
        break;
      }
    }

    if (stop) {
      // Everything still queued is untouched, not failed.
      for (const rest of toDelete.slice(i + 1)) defer(rest, "not_attempted");
      break;
    }

    await randomDelay(baseDelayMs, baseDelayMs * 3);
  }

  console.log(
    `Done. Deleted: ${summary.deleted}, Deferred: ${summary.deferred}, Failed: ${summary.failed}`,
  );

  await finalizeRun(now, summary, stateTable, snsTopicArn);
}
