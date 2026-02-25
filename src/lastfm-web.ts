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
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `csrftoken=${csrftoken}`,
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
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader(),
            Referer: `${BASE_URL}/user/${username}`,
          },
          body: body.toString(),
          redirect: "manual",
        },
      );

      if (res.status === 403) {
        throw new Error("Session expired (403). Re-authentication needed.");
      }

      if (!res.ok) {
        throw new Error(`Delete failed with status ${res.status}`);
      }

      const data = (await res.json()) as { result?: boolean };
      return data.result === true;
    },
  };
}
