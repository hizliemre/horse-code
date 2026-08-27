# horse-code

A terminal coding agent that takes a feature request from one sentence to reviewed, committed code — in its own git worktree, without touching your checkout.

```
hcode                                  # interactive REPL
hcode "add a supplier routing table"   # one prompt, run to completion
```

It is a single Node CLI (`hcode`), written in TypeScript, with an [Ink](https://github.com/vadimdemedes/ink) terminal UI. Node 20+.

---

## What it actually does

Given a request, it runs a pipeline rather than a single agent:

```
refine → size → brainstorm → constitution → specify → clarify → plan → tasks
                                                                        │
                          ┌─────────────────────────────────────────────┘
                          ▼
        implement → code review → test suite → acceptance gate → commit
              ▲            │
              └────────────┘  (revision rounds, escalating model tier)
```

Each document stage (spec, plan) is written by one role, then read by a **team of lenses** — separate agents with one perspective each (`spec-clarity`, `code-security`, `code-concurrency`, …). When the team splits, a five-member **council** votes. When the council splits, a **judge** rules. Only the judge may decide that a question belongs to you.

Implementation tasks run in parallel, each in its own worktree, and escalate through model tiers (`coder` → `senior-coder` → `architect` / `principal-coder`) when a task does not close.

## Why it is shaped this way

Three constraints drove most of the design:

**One session, one worktree.** A run never writes to the checkout you are working in. Every file an agent writes is committed as a `wip(…)` checkpoint, so a bad change is recoverable and the review always sees the whole diff — an unstaged file is a hole in the evidence.

**Every message an agent reads is a decision point.** A tool that answers "unknown tool: `view_file`" costs a full model turn to say nothing. So error messages name what exists, suggest the near miss, and say what to do next. Much of this repository is that: the difference between a syscall name and an answer.

**Measure before changing.** Almost every non-obvious line here carries the measurement that caused it, in the comment above it — how many calls, how much context, which run. If you are changing behaviour, the comment tells you what breaks.

## Install

```bash
git clone <this repo> && cd horse-code
npm install          # `prepare` builds automatically
npm link             # puts `hcode` on your PATH
```

Then, in the project you want to work on:

```bash
hcode init           # writes .horsecode/ and asks for the essentials
hcode                # start the REPL
```

## Configuration

`~/.horsecode/config.json` (global) and `.horsecode/config.json` (per project) are merged, project last.

```jsonc
{
  "apiKey": "…",
  "baseUrl": "https://…",          // any OpenAI-compatible endpoint
  "model": "cc/claude-opus-5",
  "mode": "ask",                    // ask | acceptEdits | auto
  "allowlist": ["npm test", "git status"],
  "maxParallel": 4,                 // parallel implementation tasks
  "roles": {
    "coder": { "models": ["cc/claude-opus-5", "cx/gpt-5.6-terra"], "effort": "high" }
  },
  "team": { "code": [{ "name": "code-security", "perspective": "…", "models": ["…"] }] },
  "council": { "members": [ /* … */ ] },
  "mcp": { /* Model Context Protocol servers */ },
  "telemetry": true                 // JSONL run traces under ~/.horsecode/telemetry
}
```

Every role resolves to an ordered **model chain**: the head is tried first, and a transport failure falls to the next. A model that is overloaded is benched briefly; one that is out of quota is benched for the session, and the roles it was serving are moved and moved back when it recovers.

Claude models are sent over Anthropic's own `/v1/messages` so that `effort` actually reaches them — the OpenAI-compatible endpoint accepts the field and drops it.

## In the REPL

| | |
|---|---|
| `/model`, `/roles` | see and change the model chains, per role |
| `/mode` | ask / acceptEdits / auto |
| `/memories`, `/remember`, `/forget` | the project's durable facts |
| `/skills`, `/sources` | installed skills and where they come from |
| `/graph` | build the code graph; `/graph trace` writes per-file traces |
| `/mcp` | connected MCP servers and their tools |
| `/parallel`, `/next`, `/resume`, `/sessions` | run control |
| `/clean-worktrees` | remove finished session worktrees |
| `/monitor`, `/watch` | live view of a running job |

## Memory

Facts an agent learns — a command that only works from a subdirectory, a file that is not where it looks — are written to `.horsecode/memory.jsonl` in the session worktree, so they ship with the work rather than sitting in someone's checkout. They are retrieved lexically and injected into later turns, including a slice reserved for **operational** lessons that only implementers receive.

Each role is asked, at the close of its turn, whether anything cost it more than one attempt. That question is the difference between a run that learns and one that rediscovers.

## Tools an agent has

`read_file` `write_file` `edit_file` `grep` `glob` `shell` `git` (read-only) `git_write` `web_fetch` `ask_user` `remember_fact` `propose_memory` `skill` `find_tool` `find_unfinished`, plus the graph tools (`graph_overview`, `graph_find`, `graph_context`, `graph_impact`, `graph_trace`) and every tool exposed by a connected MCP server.

Some boundaries are enforced rather than requested, because an instruction is advice and advice is what a model skips:

- `shell` refuses to rewrite a file (`edit_file` reports what changed; a heredoc does not).
- `shell` refuses a `cd` out of the working directory, and the git commands that throw away uncommitted work wholesale (`reset --hard`, `checkout -- .`).
- `git` is read-only; the writing verbs live in a separate tool.
- A call whose arguments arrive truncated is a stream that stopped, not a call — it is retried, not handed to the model as broken JSON.

## Development

```bash
npm test          # vitest — 3200+ tests
npm run typecheck # tsc --noEmit  (tsup does NOT typecheck; run this)
npm run build     # tsup → dist/
```

Tests carry the measurement that motivated them in the describe block. A test whose comment says "measured live: 27 of 90 calls" is documentation as much as a guard — if you change the behaviour, that number is what you are trading away.

## Status

Working software, used daily against a real .NET + Angular monorepo. Version `0.0.0` is honest: interfaces move when a measurement says they should.
