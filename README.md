# lastfm-scrobble-cleaner

Automatically detect and remove duplicate Last.fm scrobbles caused by apps replaying the last session on startup, deployed as an AWS Lambda on a daily schedule.

## How It Works

```
EventBridge (daily cron)
  → Lambda
    → Last.fm API: fetch recent scrobbles
    → Detect duplicates (session replay + duration overlap)
    → Last.fm Web: delete flagged scrobbles via form POST
    → CloudWatch: log results
```

**Detection uses two complementary methods:**

- **Session boundary detection** — compares the tail of one listening session with the head of the next; if they mirror, it's a startup replay
- **Playback duration check** — if the same track appears twice closer together than its actual duration, it's physically impossible and therefore a duplicate

**Deletion** uses Last.fm's web form endpoint (`POST /user/{username}/library/delete` with CSRF token), since the `library.removeScrobble` API method is dead. No headless browser needed — just HTTP requests with session cookies.

## Usage

### Test deletion locally

```sh
cp .env.example .env
# Fill in LASTFM_API_KEY, LASTFM_API_SECRET, LASTFM_USERNAME, LASTFM_PASSWORD
npm install
npm run test-delete
```

### Deploy to AWS

```sh
npm run bundle                          # build Lambda zip
cd infra && terraform init && terraform apply
```

After first deploy, populate the Secrets Manager secret with your Last.fm credentials. The Lambda runs daily at 02:00 UTC in **dry-run mode by default** — it logs what it would delete without actually deleting. Set `DRY_RUN=false` in the Lambda environment after validating the logs.

### Configuration

| Environment Variable    | Default | Description                                     |
|------------------------|---------|-------------------------------------------------|
| `LASTFM_USERNAME`      | —       | Last.fm username                                |
| `LASTFM_API_KEY`       | —       | API key from https://www.last.fm/api/account/create |
| `LASTFM_API_SECRET`    | —       | API shared secret                               |
| `LASTFM_PASSWORD`      | —       | Last.fm password (for web session auth)         |
| `DRY_RUN`              | `true`  | Set to `false` to enable live deletions         |
| `SESSION_GAP_SECONDS`  | `1800`  | Gap (seconds) that defines a new listening session |
| `FETCH_WINDOW_HOURS`   | `26`    | Hours of history to fetch (26h to catch boundary cases) |
| `MAX_DELETIONS_PER_RUN`| `20`    | Circuit breaker — max deletions per run         |
| `DELETION_DELAY_MS`    | `200`   | Base delay between deletion calls               |

## Development

### Setup

Requires Node.js >= 22 and Terraform >= 1.5.

```sh
git clone <repo-url> && cd lastfm-scrobble-cleaner
npm install
npx tsc --noEmit       # type check
npm run bundle         # build Lambda zip
```

### Structure

```
src/
  lastfm-client.ts      # Last.fm API client (read-only: scrobbles, track info)
  lastfm-web.ts          # Web session login + form-based scrobble deletion
  detect-duplicates.ts   # Session replay + duration overlap detection
  duration-cache.ts      # In-memory + DynamoDB track duration cache
  config.ts              # Environment variable loading + defaults
  handler.ts             # Lambda entry point
  test-delete.ts         # Interactive test script for deletion
infra/
  main.tf                # Terraform — Lambda, EventBridge, DynamoDB, Secrets Manager, SNS
```

### Infrastructure

Managed with Terraform (`infra/main.tf`):

- **Lambda** (Node.js 22, ARM64) — triggered daily by EventBridge
- **DynamoDB** — caches track durations to reduce API calls
- **Secrets Manager** — stores Last.fm credentials
- **CloudWatch + SNS** — error alarms
