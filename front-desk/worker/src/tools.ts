// MCP tool registrations for the front-desk endpoint.
//
// Five tools: get_profile, list_repos, ask_repo, contact_owner,
// propose_meeting. Safety posture (spec section 4):
//  - No exec/eval anywhere; inbound text is data, never instructions.
//  - The Worker never invents answers: ask_repo either relays the owner's
//    agent's verbatim answer or returns a Charles-approved static reply.
//  - Tool descriptions are plain functional text with no instructions
//    that inbound content could override.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  agentName,
  findRepo,
  isUnset,
  ownerName,
  REPO_ALLOWLIST,
  repoSlug,
  type Env,
} from "./config";
import { PROFILE_TEXT } from "./profile";
import { notify, type NotifyStatus } from "./notify";

/** Mutable per-request state owned by index.ts (used for the request log). */
export interface RequestLogState {
  tool: string;
  notifyStatus: "sent" | "queued" | "failed-queued" | "n/a";
}

export interface ToolContext {
  env: Env;
  ip: string;
  logState: RequestLogState;
}

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

// ---------------------------------------------------------------------------
// ask_repo: grounded Q&A over public repos
// ---------------------------------------------------------------------------

const STATIC_QUEUED_REPLY =
  "I can't answer that from the public material — I've passed your question to Charles and he'll get back to you.";

const CONTENT_BUDGET_BYTES = 100 * 1024; // ~100KB of fetched source text per call

const safePathSchema = z
  .string()
  .max(500)
  .transform((p) => p.replace(/^\.\/+/, "").replace(/\/+$/, ""))
  .refine(
    (p) =>
      p.length > 0 &&
      !p.includes("\\") &&
      !p.startsWith("/") &&
      !p.split("/").some((s) => s === ".." || s === ""),
    {
      message:
        "path must be a relative path: no '..' segments, no leading '/', no backslashes",
    }
  );

const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "friday-front-desk/0.2.0",
};

interface RepoFetch {
  ok: boolean;
  error?: string;
  fetched_content: string;
  files_consulted: string[];
}

function base64ToText(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Fetch public repo content server-side via the unauthenticated GitHub
 * REST API: README, file tree, and — if `path` is given — that file or
 * directory listing. Total fetched text is capped at ~100KB per call.
 */
async function fetchRepoContent(
  entryUrl: string,
  path: string | undefined
): Promise<RepoFetch> {
  const files_consulted: string[] = [];
  const chunks: string[] = [];
  let budget = CONTENT_BUDGET_BYTES;

  const take = (s: string): string => {
    if (budget <= 0) return "";
    const out = s.slice(0, budget);
    budget -= out.length;
    return out;
  };

  const slug = repoSlug(entryUrl);
  if (!slug) {
    return { ok: false, error: "Repo URL is not a github.com URL.", fetched_content: "", files_consulted };
  }

  // 1. Repo metadata (public) -> default branch.
  let branch = "main";
  try {
    const metaRes = await fetch(`${"https://api.github.com"}/repos/${slug.owner}/${slug.repo}`, {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (metaRes.status === 404) {
      return {
        ok: false,
        error: `GitHub returned 404 for ${slug.owner}/${slug.repo} — the repo may not exist yet or may be private.`,
        fetched_content: "",
        files_consulted,
      };
    }
    if (!metaRes.ok) {
      return {
        ok: false,
        error: `GitHub repo metadata request failed (HTTP ${metaRes.status}).`,
        fetched_content: "",
        files_consulted,
      };
    }
    const meta = (await metaRes.json()) as { default_branch?: string };
    if (meta.default_branch) branch = meta.default_branch;
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach the GitHub API: ${e instanceof Error ? e.message : String(e)}.`,
      fetched_content: "",
      files_consulted,
    };
  }

  const api = (p: string) => `https://api.github.com/repos/${slug.owner}/${slug.repo}${p}`;

  // 2. README (the /readme endpoint resolves README casing for us).
  try {
    const readmeRes = await fetch(api(`/readme?ref=${encodeURIComponent(branch)}`), {
      headers: { ...GH_HEADERS, Accept: "application/vnd.github.raw" },
      signal: AbortSignal.timeout(10_000),
    });
    if (readmeRes.ok) {
      const text = await readmeRes.text();
      chunks.push(`--- README ---\n${take(text)}`);
      files_consulted.push("README (via GitHub /readme)");
    }
  } catch {
    // README is best-effort; the tree below still grounds the answer.
  }

  // 3. File tree (paths only, recursive), recorded as a path list.
  try {
    const treeRes = await fetch(
      api(`/git/trees/${encodeURIComponent(branch)}?recursive=1`),
      { headers: GH_HEADERS, signal: AbortSignal.timeout(15_000) }
    );
    if (treeRes.ok) {
      const tree = (await treeRes.json()) as {
        tree?: { path?: string; type?: string }[];
        truncated?: boolean;
      };
      const paths = (tree.tree ?? [])
        .map((t) => t.path ?? "")
        .filter((p) => p.length > 0);
      const shown = paths.slice(0, 500);
      chunks.push(
        `--- FILE TREE (${paths.length} paths${tree.truncated ? ", truncated by GitHub" : ""}; first ${shown.length} shown) ---\n${take(
          shown.join("\n")
        )}`
      );
      files_consulted.push(`file tree (${paths.length} paths)`);
    }
  } catch {
    // Tree is best-effort.
  }

  // 4. Optional path: single file content, or a directory listing.
  if (path) {
    try {
      const contentRes = await fetch(
        api(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`),
        { headers: GH_HEADERS, signal: AbortSignal.timeout(10_000) }
      );
      if (contentRes.status === 404) {
        chunks.push(`--- PATH "${path}" ---\n(not found in repo)`);
        files_consulted.push(`${path} (not found)`);
      } else if (contentRes.ok) {
        const data: unknown = await contentRes.json();
        if (Array.isArray(data)) {
          // Directory listing.
          const names = (data as { name?: string; type?: string }[])
            .slice(0, 300)
            .map((e) => `${e.type === "dir" ? "[dir] " : ""}${e.name ?? ""}`);
          chunks.push(`--- DIRECTORY LISTING "${path}" (${data.length} entries) ---\n${take(names.join("\n"))}`);
          files_consulted.push(`${path}/ (directory listing, ${data.length} entries)`);
        } else if (data && typeof data === "object") {
          const f = data as { type?: string; content?: string };
          if (f.type === "file" && typeof f.content === "string") {
            const text = base64ToText(f.content);
            chunks.push(`--- FILE "${path}" ---\n${take(text)}`);
            files_consulted.push(path);
          } else {
            chunks.push(`--- PATH "${path}" ---\n(unexpected content type from GitHub API)`);
            files_consulted.push(`${path} (unreadable type)`);
          }
        } else {
          chunks.push(`--- PATH "${path}" ---\n(unexpected content type from GitHub API)`);
          files_consulted.push(`${path} (unreadable type)`);
        }
      }
    } catch (e) {
      chunks.push(`--- PATH "${path}" ---\n(fetch failed: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  return { ok: true, fetched_content: chunks.join("\n\n"), files_consulted };
}

/** Forward the grounded question to the owner's agent; return its verbatim answer. */
async function askOwnerAgent(
  env: Env,
  payload: {
    question: string;
    repo: string;
    path: string | null;
    fetched_content: string;
    files_consulted: string[];
  }
): Promise<string> {
  const url = env.OWNER_AGENT_CALLBACK_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "friday-front-desk/0.2.0" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`owner agent callback returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as { answer?: unknown };
  if (typeof data.answer !== "string" || data.answer.trim() === "") {
    throw new Error("owner agent callback did not return an {answer: string} body");
  }
  return data.answer;
}

// ---------------------------------------------------------------------------
// propose_meeting: Tier-1 negotiated hold (the only state beyond the log)
// ---------------------------------------------------------------------------

export interface PendingMeeting {
  id: string;
  name: string;
  email: string;
  phone: string;
  purpose: string;
  source: string;
  windows: string[];
  status: "pending" | "expired";
  created_at: string;
  expires_at: string;
}

// In-memory per isolate — best-effort. Pending requests are also written
// to the append-only log, which is the durable record. A durable store
// (KV/D1/Durable Objects) is a future step.
const pendingMeetings = new Map<string, PendingMeeting>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, m] of pendingMeetings) {
    if (m.status === "pending" && Date.parse(m.expires_at) <= now) {
      m.status = "expired";
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          ip: "internal",
          tool: "propose_meeting",
          params_summary: { id, lifecycle: "expired" },
          response_bytes: 0,
          rate_limited: false,
          notify_status: "n/a" as NotifyStatus,
        })
      );
      pendingMeetings.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  ctx: ToolContext
): void {
  const { env } = ctx;
  const owner = ownerName(env);
  const agent = agentName(env);

  server.tool(
    "get_profile",
    `Returns the public-safe professional profile of ${owner}.`,
    {},
    async (): Promise<CallToolResult> => {
      return textResult(PROFILE_TEXT);
    }
  );

  server.tool(
    "list_repos",
    `Lists ${owner}'s curated public repositories: name, URL, one-line description.`,
    {},
    async (): Promise<CallToolResult> => {
      const lines = REPO_ALLOWLIST.map(
        (r) => `- ${r.name} — ${r.url} — ${r.description}`
      );
      return textResult(
        `Curated public repos (static allowlist in the Worker config):\n${lines.join("\n")}`
      );
    }
  );

  server.tool(
    "ask_repo",
    `Ask a grounded question about one of ${owner}'s public repos. The endpoint fetches the repo's public README, file tree, and optionally a file or directory you point at (capped at ~100KB), forwards them with your question to ${owner}'s agent (${agent}), and returns the agent's answer verbatim with provenance (repo, files consulted, fetched-at timestamp). The agent answers only from public material; anything else gets a static queued-for-owner reply. Never invents an answer.`,
    {
      question: z
        .string()
        .min(1)
        .max(2000)
        .describe("Your question (max 2000 chars)."),
      repo: z
        .string()
        .refine((n) => findRepo(n) !== undefined, {
          message: `repo must be one of: ${REPO_ALLOWLIST.map((r) => r.name).join(", ")}`,
        })
        .describe("Repo key from list_repos."),
      path: safePathSchema
        .optional()
        .describe(
          "Optional file or directory hint inside the repo, e.g. 'src/index.ts' or 'docs'. Relative path only: no '..', no leading '/', no backslashes."
        ),
    },
    async ({ question, repo, path }): Promise<CallToolResult> => {
      const entry = findRepo(repo)!;
      const fetchedAt = new Date().toISOString();

      const fetched = await fetchRepoContent(entry.url, path);
      if (!fetched.ok) {
        // Infrastructure failure, not a question for the owner: say so plainly.
        return textResult(
          `I couldn't fetch public content for "${repo}" right now (${fetched.error}). Please try again later.`
        );
      }

      const payload = {
        question,
        repo,
        path: path ?? null,
        fetched_content: fetched.fetched_content,
        files_consulted: fetched.files_consulted,
      };

      if (!isUnset(env.OWNER_AGENT_CALLBACK_URL)) {
        try {
          const answer = await askOwnerAgent(env, payload);
          // Returned VERBATIM, wrapped with provenance.
          return textResult(
            JSON.stringify(
              {
                answer,
                provenance: {
                  repo,
                  files_consulted: fetched.files_consulted,
                  fetched_at: fetchedAt,
                },
              },
              null,
              2
            )
          );
        } catch (e) {
          console.error(
            "owner agent callback failed:",
            e instanceof Error ? e.message : e
          );
          // Fall through to the queued path: never invent an answer.
        }
      }

      // No callback configured (or it failed): log + queue for the owner.
      ctx.logState.notifyStatus = await notify(env, {
        type: "question_queued",
        summary: `Question about "${repo}" queued for ${owner}`,
        detail: { question, repo, path: path ?? null },
      });
      return textResult(STATIC_QUEUED_REPLY);
    }
  );

  server.tool(
    "contact_owner",
    `Leave a contact request for ${owner}. Collects your name, email, optional phone, and message (max 2000 chars), queues it for ${owner}, and attempts to notify him. Returns a static thank-you.`,
    {
      name: z.string().min(1).describe("Your name"),
      email: z.string().email().describe("Your email address"),
      phone: z.string().min(1).optional().describe("Your phone number (optional)"),
      message: z
        .string()
        .min(1)
        .max(2000)
        .describe(`Your message to ${owner} (max 2000 chars)`),
    },
    async ({ name, email, phone, message }): Promise<CallToolResult> => {
      ctx.logState.notifyStatus = await notify(env, {
        type: "contact",
        summary: `Contact request from ${name} (${email})`,
        detail: { name, email, phone: phone ?? null, message },
      });
      return textResult(
        `Thank you, ${name}! Your message has been queued for ${owner} and he will follow up. Note: contact details you provide may be verified against public business data sources.`
      );
    }
  );

  server.tool(
    "propose_meeting",
    `Propose a meeting with ${owner} (Tier 1 negotiated hold — the default). Provide your details and either preferred windows or, on a follow-up call, the selected window. The endpoint records a PENDING request (never a confirmed meeting) that expires in 48 hours without ${owner}'s explicit confirmation. Availability is checked read-only by ${owner}'s agent; only he can confirm and write the calendar event.`,
    {
      name: z.string().min(1).describe("Your name"),
      email: z.string().email().describe("Your email address (confirmation channel)"),
      phone: z.string().min(1).describe("Your phone number (needed for call scheduling)"),
      purpose: z
        .string()
        .min(1)
        .max(500)
        .describe("Purpose of the meeting (max 500 chars)"),
      source: z
        .string()
        .min(1)
        .describe("Which agent/endpoint you are calling from"),
      preferred_windows: z
        .array(z.string().datetime({ offset: true }))
        .optional()
        .describe("Optional ISO-8601 datetimes you prefer"),
      selected_window: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "Set on the follow-up call to pick one of the proposed windows"
        ),
    },
    async ({
      name,
      email,
      phone,
      purpose,
      source,
      preferred_windows,
      selected_window,
    }): Promise<CallToolResult> => {
      sweepExpired();

      const now = new Date();
      const pending: PendingMeeting = {
        id: crypto.randomUUID(),
        name,
        email,
        phone,
        purpose,
        source,
        windows: selected_window ? [selected_window] : preferred_windows ?? [],
        status: "pending",
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
      };
      pendingMeetings.set(pending.id, pending);

      ctx.logState.notifyStatus = await notify(env, {
        type: "meeting_pending",
        summary: `PENDING meeting request from ${name} (${email}) — ${purpose.slice(0, 80)}`,
        detail: { ...pending },
      });

      const nextSteps = selected_window
        ? `You selected ${selected_window}. ${owner}'s agent will check that window against his real availability (read-only) and ${owner} will confirm explicitly — only then is it on the calendar.`
        : `${owner}'s agent will check his real availability (read-only) and propose 2-3 concrete windows in America/New_York. To pick one, call propose_meeting again with the same details plus selected_window set to your choice.`;

      return textResult(
        `Thank you, ${name}. Your meeting request is recorded as PENDING (id: ${pending.id}) — this is a hold, not a confirmed meeting.\n\nNext steps:\n1. ${nextSteps}\n2. ${owner} confirms explicitly; nothing is written to any calendar before that.\n\nThis hold is pending ${owner}'s confirmation and expires in 48 hours.`
      );
    }
  );
}
