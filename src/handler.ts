import { loadConfig } from "./config.js";
import { createClient, type Scrobble } from "./lastfm-client.js";
import { createWebClient } from "./lastfm-web.js";
import { detectDuplicates, type FlaggedDuplicate } from "./detect-duplicates.js";
import { createDurationCache } from "./duration-cache.js";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

interface RunSummary {
  scrobblesScanned: number;
  sessionsFound: number;
  duplicatesFound: number;
  deleted: number;
  failed: number;
  dryRun: boolean;
  deletedItems: { artist: string; track: string; reason: string; timestamp: string }[];
  circuitBreakerTriggered: boolean;
}

async function sendSummaryEmail(
  topicArn: string,
  summary: RunSummary
): Promise<void> {
  const sns = new SNSClient({});

  const lines: string[] = [
    "Last.fm Scrobble Cleaner - Daily Summary",
    "========================================",
    "",
    `Scrobbles scanned: ${summary.scrobblesScanned}`,
    `Sessions found: ${summary.sessionsFound}`,
    `Duplicates detected: ${summary.duplicatesFound}`,
    "",
    `Mode: ${summary.dryRun ? "DRY RUN (no deletions)" : "LIVE"}`,
  ];

  if (summary.circuitBreakerTriggered) {
    lines.push("", "Circuit breaker triggered - limited deletions.");
  }

  if (summary.deletedItems.length > 0) {
    lines.push(
      "",
      summary.dryRun ? "Would delete:" : "Deleted:",
      ""
    );
    for (const item of summary.deletedItems) {
      lines.push(`  [${item.reason}] ${item.artist} - ${item.track}`);
      lines.push(`    Time: ${item.timestamp}`);
    }
  }

  if (!summary.dryRun && summary.duplicatesFound > 0) {
    lines.push(
      "",
      `Result: ${summary.deleted} deleted, ${summary.failed} failed`
    );
  }

  if (summary.duplicatesFound === 0) {
    lines.push("", "No duplicates found. Your scrobbles are clean!");
  }

  const message = lines.join("\n");
  const subject = summary.duplicatesFound > 0
    ? `Last.fm Cleaner: ${summary.dryRun ? "Found" : "Deleted"} ${summary.duplicatesFound} duplicate(s)`
    : "Last.fm Cleaner: No duplicates found";

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: message,
    })
  );
}

export async function handler(): Promise<void> {
  const config = await loadConfig(process.env as Record<string, string>);
  const snsTopicArn = process.env.SNS_TOPIC_ARN;
  const apiClient = createClient(config.apiKey, config.apiSecret);
  const webClient = createWebClient(config.username);

  const now = Math.floor(Date.now() / 1000);
  const from = now - config.fetchWindowHours * 3600;

  console.log(`Fetching scrobbles from ${new Date(from * 1000).toISOString()} to now`);
  console.log(`Dry run: ${config.dryRun}`);

  // Fetch all scrobbles in the window
  const allScrobbles: Scrobble[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await apiClient.getRecentTracks({
      user: config.username,
      from,
      to: now,
      limit: 200,
      page,
    });
    allScrobbles.push(...result.tracks);
    totalPages = result.totalPages;
    page++;
  }

  console.log(`Fetched ${allScrobbles.length} scrobbles across ${totalPages} page(s)`);

  // Initialize summary
  const summary: RunSummary = {
    scrobblesScanned: allScrobbles.length,
    sessionsFound: 0,
    duplicatesFound: 0,
    deleted: 0,
    failed: 0,
    dryRun: config.dryRun,
    deletedItems: [],
    circuitBreakerTriggered: false,
  };

  if (allScrobbles.length === 0) {
    console.log("No scrobbles in window. Done.");
    if (snsTopicArn) {
      await sendSummaryEmail(snsTopicArn, summary);
    }
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
    if (snsTopicArn) {
      await sendSummaryEmail(snsTopicArn, summary);
    }
    return;
  }

  for (const f of result.flagged) {
    console.log(
      `  [${f.reason}] ${f.scrobble.artist["#text"]} — ${f.scrobble.name} @ ${f.scrobble.date["#text"]}`,
    );
  }

  // Circuit breaker
  if (result.flagged.length > config.maxDeletionsPerRun) {
    console.warn(
      `Circuit breaker: ${result.flagged.length} duplicates exceed max ${config.maxDeletionsPerRun}. Only deleting first ${config.maxDeletionsPerRun}.`,
    );
    summary.circuitBreakerTriggered = true;
  }

  const toDelete = result.flagged.slice(0, config.maxDeletionsPerRun);

  // Prepare items for summary
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
    if (snsTopicArn) {
      await sendSummaryEmail(snsTopicArn, summary);
    }
    return;
  }

  // Log in to Last.fm web for deletion
  console.log("Logging in to Last.fm web...");
  await webClient.login(config.username, config.password);

  // Delete with random delays (1-10s per Pano Scrobbler's approach to avoid 406)
  for (const f of toDelete) {
    try {
      const ok = await webClient.deleteScrobble({
        artist: f.scrobble.artist["#text"],
        track: f.scrobble.name,
        timestamp: parseInt(f.scrobble.date.uts, 10),
      });
      if (ok) {
        summary.deleted++;
        console.log(`  Deleted: ${f.scrobble.artist["#text"]} — ${f.scrobble.name}`);
      } else {
        summary.failed++;
        console.error(`  Delete returned false: ${f.scrobble.artist["#text"]} — ${f.scrobble.name}`);
      }
    } catch (err: any) {
      summary.failed++;
      console.error(
        `  Failed: ${f.scrobble.artist["#text"]} — ${f.scrobble.name}: ${err.message}`,
      );
      // On 403, try re-login once
      if (err.message?.includes("403")) {
        console.log("  Re-authenticating...");
        try {
          await webClient.login(config.username, config.password);
        } catch {
          console.error("  Re-authentication failed. Stopping.");
          break;
        }
      }
    }
    await randomDelay(1000, 10000);
  }

  console.log(`Done. Deleted: ${summary.deleted}, Failed: ${summary.failed}`);

  if (snsTopicArn) {
    await sendSummaryEmail(snsTopicArn, summary);
  }
}
