/**
 * One-off script to remove all scrobbles by a specific artist from yesterday.
 *
 * Usage:
 *   npx tsx src/remove-artist-day.ts "Jonas Alaska"
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Scrobble } from "./lastfm-client.js";
import { createWebClient } from "./lastfm-web.js";

// Load .env
try {
  const envFile = readFileSync(".env", "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {
  console.error("No .env file found.");
  process.exit(1);
}

const env = (key: string): string => {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing: ${key}`);
    process.exit(1);
  }
  return val;
};

const artistArg = process.argv[2];
if (!artistArg) {
  console.error("Usage: npx tsx src/remove-artist-day.ts <artist>");
  process.exit(1);
}

// Compute yesterday's boundaries in CET (Europe/Oslo).
// In February, Norway is UTC+1.
const CET_OFFSET_HOURS = 1;

const now = new Date();
// "Yesterday" in CET: shift to CET, go back one day, take start/end of day
const cetNow = new Date(now.getTime() + CET_OFFSET_HOURS * 3600_000);
const yesterdayCet = new Date(cetNow);
yesterdayCet.setUTCDate(yesterdayCet.getUTCDate() - 1);

// Start of yesterday in CET = midnight CET = 23:00 UTC day before
const startOfDayCet = new Date(
  Date.UTC(
    yesterdayCet.getUTCFullYear(),
    yesterdayCet.getUTCMonth(),
    yesterdayCet.getUTCDate(),
    0, 0, 0,
  ),
);
const fromUtc = Math.floor(startOfDayCet.getTime() / 1000) - CET_OFFSET_HOURS * 3600;

// End of yesterday in CET = 23:59:59 CET = 22:59:59 UTC
const toUtc = fromUtc + 86400 - 1;

const fromDate = new Date(fromUtc * 1000).toISOString();
const toDate = new Date(toUtc * 1000).toISOString();

console.log(`Looking for "${artistArg}" scrobbles from yesterday (CET):`);
console.log(`  From: ${fromDate}`);
console.log(`  To:   ${toDate}`);

const username = env("LASTFM_USERNAME");
const apiClient = createClient(env("LASTFM_API_KEY"), env("LASTFM_API_SECRET"));

// Fetch all scrobbles in the window
const allScrobbles: Scrobble[] = [];
let page = 1;
let totalPages = 1;
while (page <= totalPages) {
  const result = await apiClient.getRecentTracks({
    user: username,
    from: fromUtc,
    to: toUtc,
    limit: 200,
    page,
  });
  allScrobbles.push(...result.tracks);
  totalPages = result.totalPages;
  page++;
}
console.log(`Fetched ${allScrobbles.length} total scrobbles in window.`);

// Filter to artist (case-insensitive)
const matches = allScrobbles.filter(
  (s) => s.artist["#text"].toLowerCase() === artistArg.toLowerCase(),
);

if (matches.length === 0) {
  console.log(`No scrobbles found for "${artistArg}". Nothing to do.`);
  process.exit(0);
}

console.log(`\nFound ${matches.length} scrobble(s) by "${artistArg}":\n`);
for (const s of matches) {
  console.log(`  ${s.artist["#text"]} - ${s.name}  @ ${s.date["#text"]}  (uts: ${s.date.uts})`);
}

// Confirm
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise<string>((resolve) => {
  rl.question(`\nDelete all ${matches.length} scrobble(s)? (y/n): `, resolve);
});
rl.close();

if (answer.toLowerCase() !== "y") {
  console.log("Aborted.");
  process.exit(0);
}

// Log in and delete
console.log("\nLogging in to Last.fm web...");
const webClient = createWebClient(username);
await webClient.login(username, env("LASTFM_PASSWORD"));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let deleted = 0;
let failed = 0;

for (const s of matches) {
  const artist = s.artist["#text"];
  const track = s.name;
  const timestamp = parseInt(s.date.uts, 10);

  console.log(`Deleting: ${artist} - ${track}  @ ${s.date["#text"]}`);
  try {
    const ok = await webClient.deleteScrobble({ artist, track, timestamp });
    if (ok) {
      deleted++;
      console.log("  -> Deleted");
    } else {
      failed++;
      console.log("  -> Delete returned false");
    }
  } catch (err: any) {
    failed++;
    console.error(`  -> Failed: ${err.message}`);
  }

  // Delay between deletions to avoid rate limiting
  await sleep(2000 + Math.random() * 3000);
}

console.log(`\nDone. Deleted: ${deleted}, Failed: ${failed}`);
