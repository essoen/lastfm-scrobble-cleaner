import type { Scrobble, LastfmClient } from "./lastfm-client.js";

export interface FlaggedDuplicate {
  scrobble: Scrobble;
  reason: "session-replay" | "duration-overlap" | "both";
}

interface Session {
  scrobbles: Scrobble[];
}

/**
 * Split scrobbles into sessions based on time gaps.
 * Scrobbles must be sorted newest-first (as returned by the API).
 */
function groupIntoSessions(
  scrobbles: Scrobble[],
  gapSeconds: number,
): Session[] {
  if (scrobbles.length === 0) return [];

  // Reverse to chronological order for session grouping
  const chrono = [...scrobbles].reverse();
  const sessions: Session[] = [{ scrobbles: [chrono[0]] }];

  for (let i = 1; i < chrono.length; i++) {
    const prev = parseInt(chrono[i - 1].date.uts, 10);
    const curr = parseInt(chrono[i].date.uts, 10);

    if (curr - prev > gapSeconds) {
      sessions.push({ scrobbles: [chrono[i]] });
    } else {
      sessions[sessions.length - 1].scrobbles.push(chrono[i]);
    }
  }

  return sessions;
}

/**
 * Check if the first track of the new session matches the last track of the previous session.
 * This catches resume/sync replays (e.g., Qobuz autoplay resuming an interrupted track).
 */
function detectSessionReplay(
  before: Session,
  after: Session,
): Scrobble[] {
  const lastTrack = before.scrobbles[before.scrobbles.length - 1];
  const firstTrack = after.scrobbles[0];

  if (
    lastTrack.artist["#text"] === firstTrack.artist["#text"] &&
    lastTrack.name === firstTrack.name
  ) {
    return [firstTrack];
  }

  return [];
}

/**
 * Check if two adjacent scrobbles of the same track are closer together
 * than the track's actual duration — physically impossible double play.
 */
async function detectDurationOverlaps(
  scrobbles: Scrobble[],
  client: LastfmClient,
  getDuration: (artist: string, track: string) => Promise<number | null>,
): Promise<Scrobble[]> {
  const chrono = [...scrobbles].reverse();
  const duplicates: Scrobble[] = [];

  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1];
    const curr = chrono[i];

    // Only compare same artist+track
    if (
      prev.artist["#text"] !== curr.artist["#text"] ||
      prev.name !== curr.name
    ) {
      continue;
    }

    const gap =
      parseInt(curr.date.uts, 10) - parseInt(prev.date.uts, 10);

    const durationMs = await getDuration(
      curr.artist["#text"],
      curr.name,
    );
    if (durationMs == null || durationMs === 0) continue;

    const durationSec = durationMs / 1000;

    // If gap is less than 90% of the track duration, it's a duplicate
    if (gap < durationSec * 0.9) {
      duplicates.push(curr);
    }
  }

  return duplicates;
}

export interface DetectionResult {
  flagged: FlaggedDuplicate[];
  sessionCount: number;
  scrobbleCount: number;
}

export async function detectDuplicates(
  scrobbles: Scrobble[],
  client: LastfmClient,
  gapSeconds: number,
  getDuration: (artist: string, track: string) => Promise<number | null>,
): Promise<DetectionResult> {
  const sessions = groupIntoSessions(scrobbles, gapSeconds);

  // Session replay detection
  const replayDups = new Set<string>(); // keyed by timestamp
  const replayScrobbles: Scrobble[] = [];

  for (let i = 0; i < sessions.length - 1; i++) {
    const dups = detectSessionReplay(sessions[i], sessions[i + 1]);
    for (const d of dups) {
      replayDups.add(d.date.uts);
      replayScrobbles.push(d);
    }
  }

  // Duration overlap detection
  const durationDups = await detectDurationOverlaps(
    scrobbles,
    client,
    getDuration,
  );
  const durationSet = new Set(durationDups.map((d) => d.date.uts));

  // Merge results
  const seen = new Set<string>();
  const flagged: FlaggedDuplicate[] = [];

  for (const s of replayScrobbles) {
    seen.add(s.date.uts);
    flagged.push({
      scrobble: s,
      reason: durationSet.has(s.date.uts) ? "both" : "session-replay",
    });
  }

  for (const s of durationDups) {
    if (!seen.has(s.date.uts)) {
      flagged.push({ scrobble: s, reason: "duration-overlap" });
    }
  }

  return {
    flagged,
    sessionCount: sessions.length,
    scrobbleCount: scrobbles.length,
  };
}
