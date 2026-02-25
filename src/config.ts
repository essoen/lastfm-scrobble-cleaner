import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

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
  /** Delay between deletion API calls in ms (default: 200) */
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

async function fetchSecret(secretArn: string): Promise<SecretCredentials> {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  if (!response.SecretString) {
    throw new Error("Secret has no string value");
  }
  return JSON.parse(response.SecretString) as SecretCredentials;
}

export async function loadConfig(
  env: Record<string, string | undefined>
): Promise<Config> {
  const secretArn = env.SECRET_ARN;

  let credentials: SecretCredentials;

  if (secretArn) {
    // Load credentials from Secrets Manager
    credentials = await fetchSecret(secretArn);
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
    deletionDelayMs: parseInt(env.DELETION_DELAY_MS ?? "200", 10),
    dryRun: env.DRY_RUN !== "false", // default true
  };
}
