/**
 * Test web-based scrobble deletion.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your Last.fm credentials
 *   2. Run: npm run test-delete
 *
 * This will:
 *   - Log in to Last.fm web and fetch your most recent scrobble via API
 *   - Show you the scrobble details and ask for confirmation
 *   - Attempt to delete it via the web form endpoint
 *   - Verify the deletion
 */

import { createClient } from "./lastfm-client.js";
import { createWebClient } from "./lastfm-web.js";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// Load .env
try {
  const envFile = readFileSync(".env", "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {
  console.error("No .env file found. Copy .env.example to .env and fill in your credentials.");
  process.exit(1);
}

const env = (key: string): string => {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
  return val;
};

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

async function main() {
  const username = env("LASTFM_USERNAME");
  const password = env("LASTFM_PASSWORD");
  const apiClient = createClient(env("LASTFM_API_KEY"), env("LASTFM_API_SECRET"));
  const webClient = createWebClient(username);

  // Step 1: Fetch most recent scrobble via API
  console.log("Fetching most recent scrobble...");
  const { tracks } = await apiClient.getRecentTracks({ user: username, limit: 1 });

  if (tracks.length === 0) {
    console.log("No scrobbles found.");
    return;
  }

  const scrobble = tracks[0];
  const timestamp = parseInt(scrobble.date.uts, 10);

  console.log("\nMost recent scrobble:");
  console.log(`  Artist:    ${scrobble.artist["#text"]}`);
  console.log(`  Track:     ${scrobble.name}`);
  console.log(`  Timestamp: ${timestamp} (${scrobble.date["#text"]})`);

  const ok = await confirm("\nThis will DELETE the scrobble above. Proceed?");
  if (!ok) {
    console.log("Aborted.");
    return;
  }

  // Step 2: Log in to Last.fm web
  console.log("\nLogging in to Last.fm web...");
  await webClient.login(username, password);

  // Step 3: Attempt deletion via web form
  console.log("Deleting via web form endpoint...");
  try {
    const result = await webClient.deleteScrobble({
      artist: scrobble.artist["#text"],
      track: scrobble.name,
      timestamp,
    });

    if (result) {
      console.log("\nWeb form deletion returned success.");
    } else {
      console.log("\nWeb form deletion returned false.");
    }
  } catch (err) {
    console.error("\nDeletion failed:", err);
    return;
  }

  // Step 4: Verify
  console.log("\nVerifying — re-fetching recent scrobbles...");
  const { tracks: after } = await apiClient.getRecentTracks({ user: username, limit: 1 });

  if (after.length > 0) {
    const latest = after[0];
    if (latest.name === scrobble.name && latest.date.uts === scrobble.date.uts) {
      console.log("Scrobble still present — deletion may not have worked.");
    } else {
      console.log("Scrobble gone — deletion confirmed!");
    }
  }
}

main().catch(console.error);
