import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

export interface RunSummary {
  scrobblesScanned: number;
  sessionsFound: number;
  duplicatesFound: number;
  deleted: number;
  failed: number;
  dryRun: boolean;
  deletedItems: {
    artist: string;
    track: string;
    reason: string;
    timestamp: string;
  }[];
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
