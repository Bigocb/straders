import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { API_BASE } from "../core/client.js";

const TOKEN_FILE = process.env.ST_TOKEN_FILE ?? resolve(process.cwd(), ".st-token");

/** The agent token that authenticates gameplay requests. */
export function getToken(): string | undefined {
  if (process.env.ST_TOKEN) return process.env.ST_TOKEN;
  if (existsSync(TOKEN_FILE)) {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (token) return token;
  }
  return undefined;
}

export function saveToken(token: string): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/** The account token used only to register new agents. Get it from the dashboard. */
export function getAccountToken(): string | undefined {
  return process.env.ST_ACCOUNT_TOKEN;
}

export interface RegisterResult {
  token: string;
  agentSymbol: string;
  headquarters: string;
  credits: number;
  factionSymbol: string;
}

/**
 * Register a new agent. Requires an account token (dashboard → Settings →
 * Generate Account Token) since the register endpoint now authenticates
 * against the account, not anonymously.
 */
export async function registerAgent(symbol: string, faction = "COSMIC"): Promise<RegisterResult> {
  if (!/^[a-zA-Z0-9]{3,14}$/.test(symbol)) {
    throw new Error(`Agent symbol must be 3-14 alphanumeric characters, got "${symbol}"`);
  }
  const accountToken = getAccountToken();
  if (!accountToken) {
    throw new Error(
      "No account token set. The SpaceTraders API now requires an account token to register agents. " +
        "Get one at https://my.spacetraders.io (Settings → Generate Account Token) and set ST_ACCOUNT_TOKEN.",
    );
  }
  const res = await fetch(`${API_BASE}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accountToken}`,
    },
    body: JSON.stringify({ symbol, faction }),
  });
  const json = (await res.json()) as {
    data?: { token: string; agent: { symbol: string; headquarters: string; credits: number }; faction: { symbol: string } };
    error?: { message: string; code?: number };
  };
  if (!res.ok || !json.data) {
    throw new Error(`Registration failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
  }
  return {
    token: json.data.token,
    agentSymbol: json.data.agent.symbol,
    headquarters: json.data.agent.headquarters,
    credits: json.data.agent.credits,
    factionSymbol: json.data.faction.symbol,
  };
}
