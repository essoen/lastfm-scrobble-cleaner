/**
 * Last.fm web-based deletion client.
 *
 * Uses the same approach as Pano Scrobbler: POST to the web form endpoint
 * with session cookies, bypassing the dead API method.
 *
 * Endpoint: POST https://www.last.fm/user/{username}/library/delete
 * Auth: session cookies (sessionid + csrftoken) from web login
 */

const BASE_URL = "https://www.last.fm";

/**
 * Browser-like headers shared by all web requests. Last.fm's WAF responds with
 * 406 + a "Rate Limited" page when a request looks like a bot (default Node
 * User-Agent, no Accept header). Mimicking a real browser avoids this.
 */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

interface Cookies {
  sessionid: string;
  csrftoken: string;
  raw: string; // full cookie header for requests
}

export interface LastfmWebClient {
  login(username: string, password: string): Promise<void>;
  deleteScrobble(params: {
    artist: string;
    track: string;
    timestamp: number;
  }): Promise<boolean>;
}

export type DeleteFailureReason =
  | "http_403"
  | "http_rate_limited"
  | "http_other"
  | "parse_error"
  | "result_false";

export class DeleteFailedError extends Error {
  readonly reason: DeleteFailureReason;
  readonly status: number;
  readonly bodySnippet: string;
  readonly setCookiePresent: boolean;
  /** Parsed Retry-After header in ms, if present (rate-limit responses). */
  readonly retryAfterMs?: number;
  constructor(args: {
    reason: DeleteFailureReason;
    status: number;
    bodySnippet: string;
    setCookiePresent: boolean;
    retryAfterMs?: number;
  }) {
    super(
      `${args.reason} (status ${args.status}, set-cookie=${args.setCookiePresent}): ${args.bodySnippet}`,
    );
    this.name = "DeleteFailedError";
    this.reason = args.reason;
    this.status = args.status;
    this.bodySnippet = args.bodySnippet;
    this.setCookiePresent = args.setCookiePresent;
    this.retryAfterMs = args.retryAfterMs;
  }
}

/** Parse a Retry-After header (delta-seconds form) into milliseconds. */
function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function parseCookies(headers: Headers): Map<string, string> {
  const cookies = new Map<string, string>();
  const setCookies = headers.getSetCookie();
  for (const sc of setCookies) {
    const match = sc.match(/^([^=]+)=([^;]*)/);
    if (match) cookies.set(match[1], match[2]);
  }
  return cookies;
}

export function createWebClient(username: string): LastfmWebClient {
  let cookies: Cookies | undefined;

  function cookieHeader(): string {
    if (!cookies) throw new Error("Not logged in");
    return cookies.raw;
  }

  return {
    async login(loginUsername: string, password: string): Promise<void> {
      // Step 1: GET the login page to obtain initial CSRF token
      const loginPageRes = await fetch(`${BASE_URL}/login`, {
        headers: {
          ...BROWSER_HEADERS,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "manual",
      });
      const initialCookies = parseCookies(loginPageRes.headers);
      const csrftoken = initialCookies.get("csrftoken");
      if (!csrftoken) {
        throw new Error("Failed to get CSRF token from login page");
      }

      // Step 2: POST login credentials
      const body = new URLSearchParams({
        csrfmiddlewaretoken: csrftoken,
        username_or_email: loginUsername,
        password: password,
        submit: "",
      });

      const loginRes = await fetch(`${BASE_URL}/login`, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `csrftoken=${csrftoken}`,
          Origin: BASE_URL,
          Referer: `${BASE_URL}/login`,
        },
        body: body.toString(),
        redirect: "manual",
      });

      // Login success typically redirects (302)
      const postCookies = parseCookies(loginRes.headers);
      const sessionid = postCookies.get("sessionid");
      const newCsrf = postCookies.get("csrftoken") ?? csrftoken;

      if (!sessionid) {
        throw new Error(
          `Login failed (status ${loginRes.status}). Check username/password.`,
        );
      }

      cookies = {
        sessionid,
        csrftoken: newCsrf,
        raw: `sessionid=${sessionid}; csrftoken=${newCsrf}`,
      };

      console.log("Web login successful");
    },

    async deleteScrobble({ artist, track, timestamp }): Promise<boolean> {
      if (!cookies) throw new Error("Not logged in");

      const body = new URLSearchParams({
        csrfmiddlewaretoken: cookies.csrftoken,
        artist_name: artist,
        track_name: track,
        timestamp: String(timestamp),
        ajax: "1",
      });

      const res = await fetch(
        `${BASE_URL}/user/${username}/library/delete`,
        {
          method: "POST",
          headers: {
            ...BROWSER_HEADERS,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            Cookie: cookieHeader(),
            Origin: BASE_URL,
            Referer: `${BASE_URL}/user/${username}`,
          },
          body: body.toString(),
          redirect: "manual",
        },
      );

      const respCookies = parseCookies(res.headers);
      const setCookiePresent = respCookies.size > 0;
      const newSessionid = respCookies.get("sessionid");
      const newCsrf = respCookies.get("csrftoken");
      if (newSessionid || newCsrf) {
        const sessionid = newSessionid ?? cookies.sessionid;
        const csrftoken = newCsrf ?? cookies.csrftoken;
        cookies = {
          sessionid,
          csrftoken,
          raw: `sessionid=${sessionid}; csrftoken=${csrftoken}`,
        };
      }

      const text = await res.text();
      const bodySnippet = text.slice(0, 200);

      if (res.status === 403) {
        throw new DeleteFailedError({
          reason: "http_403",
          status: 403,
          bodySnippet,
          setCookiePresent,
        });
      }

      // 406 (Last.fm's "Rate Limited" page) and 429 mean we're being throttled.
      if (res.status === 406 || res.status === 429) {
        throw new DeleteFailedError({
          reason: "http_rate_limited",
          status: res.status,
          bodySnippet,
          setCookiePresent,
          retryAfterMs: parseRetryAfter(res.headers),
        });
      }

      if (!res.ok) {
        throw new DeleteFailedError({
          reason: "http_other",
          status: res.status,
          bodySnippet,
          setCookiePresent,
        });
      }

      let data: { result?: boolean };
      try {
        data = JSON.parse(text) as { result?: boolean };
      } catch {
        throw new DeleteFailedError({
          reason: "parse_error",
          status: res.status,
          bodySnippet,
          setCookiePresent,
        });
      }

      if (data.result === true) return true;

      throw new DeleteFailedError({
        reason: "result_false",
        status: res.status,
        bodySnippet,
        setCookiePresent,
      });
    },
  };
}
