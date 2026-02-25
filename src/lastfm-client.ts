import { createHash } from "node:crypto";

const API_URL = "https://ws.audioscrobbler.com/2.0/";

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

    if (httpMethod === "GET") {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`${API_URL}?${qs}`);
      const data = await res.json();
      if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
      return data;
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Last.fm error ${data.error}: ${data.message}`);
    return data;
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
