import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

export interface Config {
  /** Last.fm username to clean */
  username: string;
  /** Last.fm API key */
  apiKey: string;
  /** Last.fm API secret */
  apiSecret: string;
  /** Last.fm password (used for web login to get session cookies for deletion) */
  password: string;
  /** Gap in seconds that defines a new session (default: 30 min) */
  sessionGapSeconds: number;
  /** Hours of scrobble history to fetch (default: 26, overlaps to catch boundaries) */
  fetchWindowHours: number;
  /** Max scrobbles to delete per run — circuit breaker (default: 20) */
  maxDeletionsPerRun: number;
  /** Base delay between deletion API calls in ms; actual delay is randomized up to 3x (default: 2000) */
  deletionDelayMs: number;
  /** If true, log what would be deleted but don't actually delete */
  dryRun: boolean;
}

interface SecretCredentials {
  apiKey: string;
  apiSecret: string;
  username: string;
  password: string;
}

async function fetchParameter(paramName: string): Promise<SecretCredentials> {
  const client = new SSMClient({});
  const response = await client.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true })
  );
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`Parameter ${paramName} has no value`);
  }
  return JSON.parse(value) as SecretCredentials;
}

export async function loadConfig(
  env: Record<string, string | undefined>
): Promise<Config> {
  const paramName = env.PARAM_NAME;

  let credentials: SecretCredentials;

  if (paramName) {
    // Load credentials from SSM Parameter Store
    credentials = await fetchParameter(paramName);
  } else {
    // Fall back to environment variables (for local dev)
    const required = (key: string): string => {
      const val = env[key];
      if (!val) throw new Error(`Missing required env var: ${key}`);
      return val;
    };
    credentials = {
      username: required("LASTFM_USERNAME"),
      apiKey: required("LASTFM_API_KEY"),
      apiSecret: required("LASTFM_API_SECRET"),
      password: required("LASTFM_PASSWORD"),
    };
  }

  return {
    username: credentials.username,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    password: credentials.password,
    sessionGapSeconds: parseInt(env.SESSION_GAP_SECONDS ?? "1800", 10),
    fetchWindowHours: parseInt(env.FETCH_WINDOW_HOURS ?? "26", 10),
    maxDeletionsPerRun: parseInt(env.MAX_DELETIONS_PER_RUN ?? "20", 10),
    deletionDelayMs: parseInt(env.DELETION_DELAY_MS ?? "2000", 10),
    dryRun: env.DRY_RUN !== "false", // default true
  };
}
