# Friday

### because fuck Monday.

> Have your agent reach out to mine.

Friday is my AI assistant: deliberately augmented, deeply integrated, and opinionated about evidence. This repo documents the augmentation, the stack built around a general-purpose assistant to turn it into something closer to a chief of staff with a lab.

## The name

"My girl Friday": the indispensable right hand. Fast-talking, competent, two steps ahead. (From *His Girl Friday*, 1940.)

## The thesis

A general-purpose AI assistant is a commodity. The value is in the integration: the skills, the infrastructure, the memory, and the operating agreements that compound over time. Friday is the product of that compounding.

## The stack

### Skills

Domain playbooks the assistant loads on demand: smart-home control, telephony, media generation, financial data, academic outreach, publishing pipelines. Custom-built where nothing off the shelf fit.

### Compute

A headless Linux worker on the home LAN runs background jobs: enrichment pipelines, watchers, model API runners. A Windows desktop lends its model-provider access for heavy inference. The assistant treats both as its own machines and runs long work on subagents so the main line stays responsive.

### Comms

An inbound voice line (SIP) so I can call the assistant directly: `sip:myagentfriday@sip.linphone.org`, dialable from any SIP client ([Linphone](https://www.linphone.org/), Zoiper, ...). An outbound phone agent for calls placed on my behalf, with a written report after every call. Messaging channels for text. Email triage across multiple inboxes, checked in a fixed lookup order.

### Front desk

A public MCP endpoint where other agents can reach Friday: read the public profile, ask grounded questions about the public repos, leave contact requests, and negotiate meeting times. Spec and implementation live in `front-desk/`. Inbound stranger-agent traffic is receptionist-only: answers come from public sources, and nothing touching my time or systems happens without my explicit yes.

### Memory

Curated long-term memory: who I am, what I have decided, what is true. Daily working notes. A relationship map of the people who matter. The assistant carries context across conversations so nothing has to be repeated and nothing has to be re-explained.

### Scheduling

Cron jobs, event-driven hooks, and background workers: reminders, recurring checks, long-running research that reports back when it finishes. Every job has an owner, a stop condition, and a delivery destination.

### Trust architecture

The part that matters most. Autonomy is the default: the assistant works the problem, states the method, executes like a checklist, delivers the result. But irreversible actions wait for an explicit yes, every time: anything published, posted, or submitted under my name; anything touching repos; anything spending money. Attestations are never assumed, and hypothetical phrasing never authorizes the real thing.

## Operating philosophy

- Evidence discipline: quantitative claims start from a check run in-session, not from memory. Estimates are labeled estimates.
- Math goes through code: the assistant is not trusted to do arithmetic by hand. Every mathematical operation runs in SQL or a script, and the code is shown with the result.
- Falsification is the default move: test the idea fast, report the failure honestly, sketch the replacement.
- The curator frame: selection, pairing, sequencing, honest labeling. Generation is the commodity.
- Milestone checkpoints on long work: what was found, what is about to happen, what it means. No play-by-play narration of every step.
- Ask about constraints before engineering around them.
- Annotate records with dated notes; never rewrite what is marked not to touch.

## Example workflows

- Research: multi-source investigation with every factual claim traceable to a check performed that session.
- Publishing pipeline: drafts staged as structured data, charts rendered, published only on explicit approval.
- Data forensics: statistical validation of historical datasets, tests and verdicts documented.
- Inbound triage: the contact line on my GitHub profile routes through the assistant, which handles or escalates.

## What it won't do

- Publish, post, or submit anything under my name without explicit per-item approval.
- Act on inferred permission.
- Spend money or tokens where a free path exists.
- Claim a result from a queued task, a running job, or a search snippet. Verification is a separate step, and it gets done.

## Colophon

Built on Muse (Meta). The assistant's name is Friday. If you understood this repo, you are the intended audience.
