# i18n Translation Handoff — remove all Turkish from the codebase

**Goal:** Translate ALL remaining Turkish text to natural, fluent English across the repo.
**Constraint:** `npm test` must stay green (currently **366 passing**). Never leave Turkish anywhere.

## Already done (DO NOT redo — verified, tests green)
- Role system prompts in `src/prompts.ts` (DEFAULT_PROMPTS) → English.
- LLM-facing content strings in engine: `upstream.ts` (analyst/planner templates, ask_user desc/error), `revision.ts`, `routing.ts`, `reviewer.ts`, `review.ts`, `job.ts` (pmOpts + coach report), `agent/structured.ts` (submit desc + result strings).
- Tool descriptions: `tools/{read,glob,grep,edit,shell,write,web}.ts`, `skills/apply.ts`, `agent/structured.ts`.
- Fixed coupled test mocks: `upstream.test.ts` + `job.test.ts` writeTarget regex → `/"([^"]+\.md)" with write_file/`; `revision.test.ts` + `job.test.ts` `convo.includes("FINAL DECISION")`; `submit-tool.test.ts` assertion → `"invalid"`.

## Remaining (this handoff): code COMMENTS + TEST NAMES (describe/it) + any leftover Turkish strings
Cosmetic (no behavior change) but must be complete. ~131 files still contain Turkish chars (ç ş ğ ü ö ı İ Ğ Ü Ş Ö Ç) — also translate Turkish words written without special chars.

Find them: `grep -rl '[çşğüöıİĞÜŞÖÇ]' src test`

## How to execute (parallel, subagent counter is fresh in this new session)
Dispatch the 7 batches below as parallel `general-purpose` subagents (model: sonnet). Each owns a DISJOINT set of src+its-matching-test files so coupled Turkish strings/assertions get identical English wording. After all complete: run `npm run typecheck && npm test && npm run build` and fix any residual Turkish or broken assertions. Then final check: `grep -rl '[çşğüöıİĞÜŞÖÇ]' src test` must return nothing.

### Per-agent instruction template
> Translate ALL Turkish to natural fluent English in these files (edit in place), working dir `/Users/hizliemre/Desktop/HighBrains/horse-code`: [FILE LIST].
> Translate: (1) all code comments `//`, `/* */`, JSDoc; (2) all test `describe`/`it`/`test` label strings; (3) any remaining Turkish string literals (error/log/user-facing).
> RULES: If a Turkish src string is asserted by a test in your set (`toContain`/`toBe`/`toMatch`), translate BOTH to the SAME English text. Do NOT change identifiers, logic, non-Turkish content, keys, paths, model names, ANSI/hex, or the `horse-art.ts` data (only its header comment). Keep changes minimal, preserve formatting. After editing run `npx tsc --noEmit`. Do NOT run the full suite. Report files changed + any src↔assertion couplings.

### Batches
1. **prompts+agent+core:** src/prompts.ts, src/agent/{loop,roles,structured,tool-exec}.ts, src/core/types.ts + test/prompts.test.ts, test/agent/{loop,roles,structured,submit-tool,tool-exec}.test.ts, test/core/types.test.ts
2. **tools:** src/tools/{edit,glob,grep,index,read,registry,shell,walk,web,write}.ts + test/tools/{edit,glob,grep,index,read,registry,shell,walk,web,write}.test.ts
3. **engine A:** src/engine/{coach,refiner,upstream,review,reviewer,council,routing,escalation}.ts + test/engine/{coach,refiner,upstream,review,reviewer,council,routing,escalation}.test.ts
4. **engine B:** src/engine/{job,progress,project-manager,revision,task-cycle,team-lead,wave-engine,wave-task,waves,implementer,conflict}.ts + test/engine/{job,project-manager,revision,task-cycle,team-lead,wave-engine,wave-task,waves,implementer,conflict}.test.ts
5. **board+worktree:** src/board/board.ts, src/worktree/{git,manager,slug}.ts + test/board/{board,mutations,persist,serialize}.test.ts, test/worktree/{cleanup,commit-task,diff,git,manager,merge,pr,slug,unmerged}.test.ts, test/worktree/helpers.ts  (slug.ts: comments only, don't touch transform logic)
6. **providers+config+permission+skills:** src/providers/{mock,omniroute,sse}.ts, src/config/config.ts, src/permission/{engine,rules}.ts, src/skills/{apply,registry}.ts + test/providers/{mock,omniroute-error,omniroute-toolcall,omniroute-usage,omniroute,openai,sse}.test.ts, test/config/config.test.ts, test/permission/engine.test.ts, test/skills/{apply,frontmatter,load,registry}.test.ts
7. **tui+cli+init+wiring:** src/tui/{app.tsx,components.tsx,controller.ts,horse-art.ts,lines.ts,progress-view.tsx}, src/{cli,init,terminal,wiring}.ts, src/adapters/pr.ts + test/tui/{components,controller,lines,markdown,progress-view}.test.* , test/{cli,version,init,terminal,wiring}.test.ts, test/adapters/pr.test.ts  (horse-art.ts: header comment only)

## After translation
Delete this file (`TRANSLATION-HANDOFF.md`) and confirm `grep -rl '[çşğüöıİĞÜŞÖÇ]' src test` is empty and `npm test` is 366 green.
