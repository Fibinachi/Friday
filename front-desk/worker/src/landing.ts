// Landing page (GET /): human/agent-readable front door for the endpoint.

import { html } from "hono/html";
import type { Context } from "hono";
import { agentName, ownerName, REPO_ALLOWLIST, type Env } from "./config";

export const HOUSE_CONTACT_LINE =
  "Have your agent reach out to mine: Friday, at charles@gridataset.com";

export function renderLanding(
  c: Context<{ Bindings: Env }>,
  env: Env
): Response | Promise<Response> {
  const owner = ownerName(env);
  const agent = agentName(env);
  const endpoint = env.MCP_ENDPOINT_URL?.trim() || "(this origin)/mcp";

  return c.html(
    html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">
    <title>${agent} — agent front desk for ${owner}</title>
  </head>
  <body>
    <header>
      <h1>${agent} — agent front desk for ${owner}</h1>
      <p>This is a public MCP endpoint where visiting agents can read public material about ${owner}, ask grounded questions about his public work, leave contact requests, and negotiate meeting times.</p>
    </header>
    <main>
      <h2>Endpoint</h2>
      <p>MCP (Streamable HTTP): <code>${endpoint}</code></p>
      <p>Machine-readable discovery: <a href="/.well-known/agent-mcp"><code>/.well-known/agent-mcp</code></a></p>

      <h2>What visiting agents can do</h2>
      <ul>
        <li><strong>get_profile</strong> — fetch ${owner}'s public-safe professional profile.</li>
        <li><strong>list_repos</strong> — list the curated public repos:
          <ul>${REPO_ALLOWLIST.map(
            (r) => html`<li><a href="${r.url}">${r.name}</a> — ${r.description}</li>`
          )}</ul>
        </li>
        <li><strong>ask_repo</strong> — ask a grounded question about a public repo. The endpoint fetches the repo's public README and file tree, forwards them with the question to ${owner}'s agent, and returns the agent's answer verbatim with provenance. Answers come only from public material.</li>
        <li><strong>contact_owner</strong> — leave a contact request (name, email, optional phone, message). Queued for ${owner}; nothing is sent on his behalf.</li>
        <li><strong>propose_meeting</strong> — propose a meeting (Tier 1 negotiated hold). Creates a <em>pending</em> request that expires in 48 hours without ${owner}'s explicit confirmation. A pending hold is never a confirmed meeting.</li>
      </ul>

      <h2>Privacy note</h2>
      <p>Contact details you provide may be verified against public business data sources.</p>

      <h2>Contact</h2>
      <p>${HOUSE_CONTACT_LINE}</p>

      <h2>Spec</h2>
      <p>Built to the front-desk technical spec (v0.2), <code>SPEC.md</code> in the source repo.</p>
    </main>
    <footer>
      <p>Read-only by design: this endpoint logs requests, queues contact/meeting requests, and answers from public material. It never writes to ${owner}'s systems and never sends messages on his behalf.</p>
    </footer>
  </body>
</html>`
  );
}
