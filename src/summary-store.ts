import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

/**
 * Identity of a scrobble inside a summary.
 *
 * `uts` is the real key: `timestamp` is Last.fm's display string and only has
 * minute precision, so a replay glitch can produce several scrobbles of the
 * same track inside one minute. Optional because summaries written before
 * 2026-09 (still inside the 14-day TTL window) don't carry it.
 */
interface ScrobbleRef {
  artist: string;
  track: string;
  timestamp: string;
  uts?: string;
}

export interface DeletedItem extends ScrobbleRef {
  reason: string;
}

export interface FailedItem extends ScrobbleRef {
  reason: string;
  detail: string;
}

/** Rate-limited or never attempted — expected to retry on a later run. */
export interface DeferredItem extends ScrobbleRef {
  reason: string;
}

export interface RunSummary {
  scrobblesScanned: number;
  sessionsFound: number;
  duplicatesFound: number;
  /** Deletions that actually succeeded. */
  deleted: number;
  /** Genuine failures — not rate-limiting, which is deferred instead. */
  failed: number;
  deferred?: number;
  dryRun: boolean;
  deletedItems: DeletedItem[];
  failedItems: FailedItem[];
  deferredItems?: DeferredItem[];
  circuitBreakerTriggered: boolean;
}

export interface DailySummaryRecord {
  date: string;
  summary: RunSummary;
}

export interface SummaryStore {
  put(date: Date, summary: RunSummary): Promise<void>;
  getLastSevenDays(endDate: Date): Promise<DailySummaryRecord[]>;
}

const TTL_DAYS = 14;

export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function summaryKey(date: Date): string {
  return `summary#${formatDate(date)}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function createSummaryStore(tableName: string): SummaryStore {
  const client = new DynamoDBClient({});

  return {
    async put(date: Date, summary: RunSummary): Promise<void> {
      const ttlSeconds =
        Math.floor(date.getTime() / 1000) + TTL_DAYS * 24 * 3600;
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: summaryKey(date) },
            data: { S: JSON.stringify(summary) },
            ttl: { N: String(ttlSeconds) },
          },
        }),
      );
    },

    async getLastSevenDays(endDate: Date): Promise<DailySummaryRecord[]> {
      const dates: Date[] = [];
      for (let i = 6; i >= 0; i--) {
        dates.push(addDays(endDate, -i));
      }

      const results = await Promise.all(
        dates.map(async (d): Promise<DailySummaryRecord | null> => {
          const res = await client.send(
            new GetItemCommand({
              TableName: tableName,
              Key: { pk: { S: summaryKey(d) } },
            }),
          );
          if (!res.Item || !res.Item.data?.S) return null;
          try {
            const summary = JSON.parse(res.Item.data.S) as RunSummary;
            return { date: formatDate(d), summary };
          } catch {
            return null;
          }
        }),
      );

      return results.filter((r): r is DailySummaryRecord => r !== null);
    },
  };
}
