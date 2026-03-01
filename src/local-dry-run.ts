/**
 * Local dry-run: invokes the handler with a custom fetch window.
 * Usage: FETCH_WINDOW_HOURS=168 npx tsx src/local-dry-run.ts
 */

import { readFileSync } from "node:fs";
import { handler } from "./handler.js";

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

// Ensure dry run
process.env.DRY_RUN = "true";

await handler();
