# CLAUDE.md

This file provides context for Claude Code when working on this repository.

## Project Overview

Last.fm Scrobble Cleaner - An AWS Lambda that runs daily to detect and remove duplicate scrobbles caused by apps replaying the last listening session on startup.

## Architecture

- **Runtime**: Node.js 22, TypeScript, ESM modules
- **Infrastructure**: Terraform (in `infra/`)
- **Deployment**: AWS Lambda (ARM64) triggered by EventBridge daily at 02:00 UTC

### AWS Resources

- Lambda function with 256MB memory, 5 min timeout
- DynamoDB table for caching track durations
- Secrets Manager for Last.fm credentials
- SNS topic for daily summary emails and error alerts
- CloudWatch alarm for Lambda failures

## Key Files

```
src/
  handler.ts          # Lambda entry point
  config.ts           # Env var loading, Secrets Manager integration
  lastfm-client.ts    # Last.fm API client (read-only operations)
  lastfm-web.ts       # Web session login + form-based scrobble deletion
  detect-duplicates.ts # Duplicate detection logic
  duration-cache.ts   # Track duration caching
infra/
  main.tf             # Terraform infrastructure
```

## Duplicate Detection

**Note:** This was built for Qobuz, which scrobbles at the *start* of a track (not at 50% like most scrobblers). This affects the detection logic.

Two methods used together:

1. **Session replay** - First track of a new session matches the last track of the previous session. Catches Qobuz's sync behavior where resuming playback on another device re-scrobbles the interrupted track.
2. **Duration overlap** - Same track scrobbled twice closer together than its actual duration. Catches skipped songs that weren't really listened to.

## Commands

```sh
npm run bundle        # Build Lambda zip (esbuild)
npm run deploy        # Bundle + terraform apply
npm run test-delete   # Local interactive test script
```

## Environment Variables

Lambda reads credentials from Secrets Manager (`SECRET_ARN` env var). For local dev, use `.env` file with:
- `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `LASTFM_USERNAME`, `LASTFM_PASSWORD`

Key config:
- `DRY_RUN=true` (default) - Logs what would be deleted without deleting
- `MAX_DELETIONS_PER_RUN=20` - Circuit breaker

## Deletion Approach

Last.fm's `library.removeScrobble` API is dead. Deletion uses the web form endpoint (`POST /user/{username}/library/delete`) with CSRF token and session cookies - no headless browser needed.

## Notes

- The Lambda sends a daily email summary via SNS with scrobbles scanned, duplicates found, and actions taken
- All resources are tagged with `Project=lastfm-scrobble-cleaner`, `Environment=prod`, `ManagedBy=terraform`
