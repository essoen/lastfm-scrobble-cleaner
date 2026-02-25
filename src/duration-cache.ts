import type { LastfmClient } from "./lastfm-client.js";

/**
 * In-memory cache backed by DynamoDB for track durations.
 * Falls back to Last.fm API on cache miss, then stores the result.
 *
 * When running in Lambda, the DynamoDB backing is used.
 * For local testing, the in-memory cache alone works fine.
 */
export interface DurationCache {
  get(artist: string, track: string): Promise<number | null>;
}

export function createDurationCache(
  client: LastfmClient,
  dynamoGet?: (key: string) => Promise<number | null>,
  dynamoPut?: (key: string, duration: number) => Promise<void>,
): DurationCache {
  const mem = new Map<string, number | null>();

  return {
    async get(artist: string, track: string): Promise<number | null> {
      const key = `${artist.toLowerCase()}::${track.toLowerCase()}`;

      if (mem.has(key)) return mem.get(key)!;

      // Try DynamoDB
      if (dynamoGet) {
        const cached = await dynamoGet(key);
        if (cached != null) {
          mem.set(key, cached);
          return cached;
        }
      }

      // Fetch from API
      try {
        const info = await client.getTrackInfo({ artist, track });
        const duration = parseInt(info.duration, 10) || null;
        mem.set(key, duration);
        if (duration != null && dynamoPut) {
          await dynamoPut(key, duration).catch(() => {}); // best-effort
        }
        return duration;
      } catch {
        mem.set(key, null);
        return null;
      }
    },
  };
}
