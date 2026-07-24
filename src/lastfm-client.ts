import { createHash } from "node:crypto";

const API_URL = "https://ws.audioscrobbler.com/2.0/";

// Transient Last.fm application error codes worth retrying:
// 8 = Operation failed (backend service failed), 11 = Service Offline,
// 16 = temporarily unavailable, 29 = rate limit exceeded.
const TRANSIENT_ERROR_CODES = new Set([8, 11, 16, 29]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Marks an error thrown inside call() as safe to retry.
class RetryableError extends Error {}

export interface Scrobble {
  artist: { "#text": string; mbid: string };
  name: string;
  mbid: string;
  url: string;
  date: { uts: string; "#text": string };
  "@attr"?: { nowplaying: string };
}

export interface TrackInfo {
  name: string;
  artist: { name: string };
  duration: string; // milliseconds as string
}

export interface LastfmClient {
  getRecentTracks(params: {
    user: string;
    from?: number;
    to?: number;
    limit?: number;
    page?: number;
  }): Promise<{ tracks: Scrobble[]; totalPages: number }>;

  getTrackInfo(params: {
    artist: string;
    track: string;
  }): Promise<TrackInfo>;

  getSessionKey(username: string, password: string): Promise<string>;
}

function sign(
  params: Record<string, string>,
  secret: string,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return createHash("md5")
    .update(sorted + secret)
    .digest("hex");
}

export function createClient(
  apiKey: string,
  apiSecret: string,
  existingSessionKey?: string,
): LastfmClient {
  let sessionKey: string | undefined = existingSessionKey;

  async function call(
    method: string,
    extraParams: Record<string, string> = {},
    httpMethod: "GET" | "POST" = "GET",
  ): Promise<unknown> {
    const params: Record<string, string> = {
      method,
      api_key: apiKey,
      format: "json",
      ...extraParams,
    };

    if (sessionKey) {
      params.sk = sessionKey;
    }

    // Signed requests: exclude 'format' from signature
    if (httpMethod === "POST" || sessionKey) {
      const sigParams = { ...params };
      delete sigParams.format;
      params.api_sig = sign(sigParams, apiSecret);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        let res: Response;
        try {
          if (httpMethod === "GET") {
            const qs = new URLSearchParams(params).toString();
            res = await fetch(`${API_URL}?${qs}`);
          } else {
            res = await fetch(API_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(params).toString(),
            });
          }
        } catch (err) {
          // Network/DNS/socket failure — transient.
          throw new RetryableError(
            `Network error calling Last.fm: ${(err as Error).message}`,
          );
        }

        // Non-2xx (5xx, or a WAF 406 HTML page) — transient.
        if (!res.ok) {
          throw new RetryableError(`Last.fm HTTP ${res.status}`);
        }

        let data: any;
        try {
          data = await res.json();
        } catch {
          // Non-JSON body (HTML rate-limit/challenge page) — transient.
          throw new RetryableError("Last.fm returned a non-JSON response");
        }

        if (data.error) {
          const message = `Last.fm error ${data.error}: ${data.message}`;
          if (TRANSIENT_ERROR_CODES.has(data.error)) {
            throw new RetryableError(message);
          }
          // Permanent error (bad params, auth, invalid key, ...) — fail fast.
          throw new Error(message);
        }

        return data;
      } catch (err) {
        const retryable = err instanceof RetryableError;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        console.warn(
          `Retrying ${method} after transient error ` +
            `(attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${(err as Error).message}`,
        );
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  return {
    async getSessionKey(username: string, password: string): Promise<string> {
      const data = (await call("auth.getMobileSession", {
        username,
        password,
      }, "POST")) as { session: { key: string } };
      sessionKey = data.session.key;
      return sessionKey;
    },

    async getRecentTracks({ user, from, to, limit = 200, page = 1 }) {
      const params: Record<string, string> = {
        user,
        limit: String(limit),
        page: String(page),
      };
      if (from != null) params.from = String(from);
      if (to != null) params.to = String(to);

      const data = (await call("user.getRecentTracks", params)) as {
        recenttracks: {
          track: Scrobble[];
          "@attr": { totalPages: string };
        };
      };

      // Filter out "now playing" track (no date)
      const tracks = data.recenttracks.track.filter(
        (t) => !t["@attr"]?.nowplaying,
      );

      return {
        tracks,
        totalPages: parseInt(data.recenttracks["@attr"].totalPages, 10),
      };
    },

    async getTrackInfo({ artist, track }) {
      const data = (await call("track.getInfo", {
        artist,
        track,
        autocorrect: "1",
      })) as { track: TrackInfo };
      return data.track;
    },

  };
}
