// Shared configuration and Worker environment bindings.
//
// Everything configurable lives in wrangler.jsonc `vars` — no secrets,
// no private credentials anywhere in this Worker.

export interface Env {
  MCP_OWNER_NAME: string;
  MCP_AGENT_NAME: string;
  MCP_ENDPOINT_URL: string;
  OWNER_AGENT_CALLBACK_URL: string;
  NOTIFY_WEBHOOK_URL: string;
}

export function ownerName(env: Env): string {
  return env.MCP_OWNER_NAME || "Charles Prescott";
}

export function agentName(env: Env): string {
  return env.MCP_AGENT_NAME || "Friday";
}

/** Empty string (or a literal PLACEHOLDER) means "not configured". */
export function isUnset(v: string | undefined | null): boolean {
  if (!v) return true;
  const t = v.trim();
  return t === "" || t.toUpperCase().startsWith("PLACEHOLDER");
}

export interface RepoEntry {
  /** Short key visitors pass to ask_repo. */
  name: string;
  /** Public GitHub URL. */
  url: string;
  /** One-line description. */
  description: string;
}

/**
 * Curated public-repo allowlist — the source of truth is this file,
 * not a live GitHub crawl. To add a repo, append an entry here and redeploy.
 */
export const REPO_ALLOWLIST: RepoEntry[] = [
  {
    name: "friday",
    url: "https://github.com/Fibinachi/friday",
    description: "Friday: the assistant augmentation portfolio",
  },
  {
    name: "linearb-ledger",
    url: "https://github.com/Fibinachi/linearb-ledger",
    description: "QuickBooks-style reconstruction of a Mycenaean Bronze Age ledger",
  },
];

export function findRepo(name: string): RepoEntry | undefined {
  return REPO_ALLOWLIST.find((r) => r.name === name);
}

/** Parse "owner/repo" out of a https://github.com/<owner>/<repo> URL. */
export function repoSlug(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}
