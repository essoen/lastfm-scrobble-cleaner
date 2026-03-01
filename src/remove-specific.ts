/**
 * One-off script to remove specific flagged duplicates.
 * First fetches scrobbles to get exact timestamps, then deletes.
 */

import { readFileSync } from "node:fs";
import { createClient } from "./lastfm-client.js";
import { createWebClient } from "./lastfm-web.js";
import { detectDuplicates } from "./detect-duplicates.js";
import { createDurationCache } from "./duration-cache.js";

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
  if (!val) { console.error(`Missing: ${key}`); process.exit(1); }
  return val;
};

const username = env("LASTFM_USERNAME");
const apiClient = createClient(env("LASTFM_API_KEY"), env("LASTFM_API_SECRET"));
const webClient = createWebClient(username);

// Fetch 7 days of scrobbles
const now = Math.floor(Date.now() / 1000);
const from = now - 168 * 3600;

console.log("Fetching scrobbles for the last 7 days...");
const allScrobbles = [];
let page = 1;
let totalPages = 1;
while (page <= totalPages) {
  const result = await apiClient.getRecentTracks({ user: username, from, to: now, limit: 200, page });
  allScrobbles.push(...result.tracks);
  totalPages = result.totalPages;
  page++;
}
console.log(`Fetched ${allScrobbles.length} scrobbles`);

// Detect duplicates
const cache = createDurationCache(apiClient);
const result = await detectDuplicates(
  allScrobbles,
  apiClient,
  1800,
  (artist, track) => cache.get(artist, track),
);

// Filter to only duration-overlap flagged items (items #3-5 from the dry run)
const toDelete = result.flagged.filter(f => f.reason === "duration-overlap");

console.log(`\nFound ${toDelete.length} duration-overlap duplicate(s) to remove:`);
for (const f of toDelete) {
  console.log(`  ${f.scrobble.artist["#text"]} — ${f.scrobble.name} @ ${f.scrobble.date["#text"]} (uts: ${f.scrobble.date.uts})`);
}

if (toDelete.length === 0) {
  console.log("Nothing to delete.");
  process.exit(0);
}

// Log in and delete
console.log("\nLogging in to Last.fm web...");
await webClient.login(username, env("LASTFM_PASSWORD"));

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let deleted = 0;
let failed = 0;

for (const f of toDelete) {
  const { artist, name: track, date } = f.scrobble;
  const timestamp = parseInt(date.uts, 10);
  console.log(`\nDeleting: ${artist["#text"]} — ${track} @ ${date["#text"]}`);
  try {
    const ok = await webClient.deleteScrobble({ artist: artist["#text"], track, timestamp });
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
