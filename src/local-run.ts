/**
 * Local real run: invokes the handler against a custom fetch window and
 * deletes for real (pass DRY_RUN=false). Safe-by-default: stays a dry run
 * unless DRY_RUN=false is explicitly set.
 *
 * Usage: DRY_RUN=false FETCH_WINDOW_HOURS=672 MAX_DELETIONS_PER_RUN=500 npx tsx src/local-run.ts
 */

import { readFileSync } from "node:fs";
import { handler } from "./handler.js";

// Load .env without clobbering variables already set in the shell, so
// command-line overrides (DRY_RUN, FETCH_WINDOW_HOURS, ...) survive.
try {
  const envFile = readFileSync(".env", "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (process.env[key] === undefined) process.env[key] = match[2].trim();
    }
  }
} catch {
  console.error("No .env file found. Copy .env.example to .env and fill in your credentials.");
  process.exit(1);
}

await handler();
