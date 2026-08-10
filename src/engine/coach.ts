import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message, Provider } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { compactHistory, historyTokens } from "./compaction.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";

// Two-layer context: keep the full transcript on disk, but compact the in-context history once it grows
// past this budget (the coach model is large, so this rarely fires in short sessions).
const COMPACT_MAX_TOKENS = 100_000;
const COMPACT_KEEP_RECENT = 8; // recent turns kept verbatim after the summary
const COMPACT_RESUMMARIZE_TOKENS = 4_000; // re-fold the delta into the summary only after it grows this much

/** One cheap-model call that compresses the ancient region of a conversation, preserving key facts. */
async function summarizeConversation(deps: TaskCycleDeps, conversation: string): Promise<string> {
  const model = deps.roleRegistry.peekModel("refiner") || deps.roleRegistry.peekModel("coach");
  const opts: RoleAgentOptions = {
    provider: deps.provider as Provider,
    model,
    systemPrompt:
      "You compress earlier conversation turns into a concise briefing. PRESERVE verbatim-important facts: " +
      "decisions made, corrections, errors encountered, file paths, names, and the user's stated preferences. " +
      "Drop pleasantries and filler. Output terse bullet points, no preamble.",
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: `Summarize the earlier conversation below:\n\n${conversation}` }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: ".",
    signal: deps.signal,
    /**
     * Deliberately no `onSay`.
     *
     * This one is not talking to anyone: it compresses earlier turns into a briefing that goes back into the
     * coach's own context. It has no tools, so it produces exactly one message, and that message IS the
     * summary — printing it would show the user a condensed replay of the conversation they just had.
     */
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}

/**
 * Coach chat: answers the prompt using read-only repo tools (read/grep/glob + skill); returns the final text.
 * `history` is the previous conversation turns (user/assistant) → multi-turn session consistency (the conversation progresses).
 */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string, history: Message[] = [], language?: string, images?: string[]): Promise<string> {
  const { model, fallbacks, systemPrompt, onExhausted, onFallback } = deps.roleRegistry.resolve("coach");
  // The refined prompt is always English; tell the coach the real model + the user's original language so
  // "which model are you?" is answered truthfully and the reply comes back in the language the user used.
  const pins = deps.pins?.() ?? [];
  const pinBlock = pins.length ? `\n\nUser pins (always honor these):\n${pins.map((p) => `- ${p}`).join("\n")}` : "";
  const context = `\n\nContext: this session is powered by the "${model}" model.` +
    (language ? ` Respond in ${language}.` : "") +
    ` When it helps, end your reply with a <nextsteps> block: 2-4 short, concrete follow-up actions the` +
    ` user might pick next, one per line prefixed with "- ". Omit the block when there is no useful next step.` +
    ` If the user states a durable BEHAVIORAL RULE about HOW you should work — language, style, conventions,` +
    ` or an "always/never" directive (e.g. "always answer in Turkish", "keep code comments in English",` +
    ` "always use pnpm") — emit a <rule> block with 1-3 short rules, one per line prefixed with "- ".` +
    ` Separately, if the user states a durable FACT worth recalling (an endpoint, version, or decision — e.g.` +
    ` "the API base is X", "we target Node 22"), emit a <remember> block with 1-3 short facts, one per line` +
    ` prefixed with "- ". Never remember transient, trivial, or one-off things.` +
    ` Separately, if the user corrects you, points out a mistake, or an approach fails and is then fixed,` +
    ` emit a <lesson> block: 1-2 short lessons, each stating what went wrong AND the correct approach, one` +
    ` per line prefixed with "- ". Only for genuine corrections or failures — not routine answers.` +
    pinBlock;
  // Compact the in-context history when it exceeds the budget (summarize the old region, keep recent turns).
  // The summary is cached across turns → a summarizer call fires only when the delta grows past the threshold.
  const { messages: compacted, cache } = await compactHistory(
    history,
    {
      maxTokens: COMPACT_MAX_TOKENS,
      keepRecent: COMPACT_KEEP_RECENT,
      reSummarizeTokens: COMPACT_RESUMMARIZE_TOKENS,
      summarize: (conversation) => summarizeConversation(deps, conversation),
    },
    deps.compactionState?.value,
  );
  if (deps.compactionState) deps.compactionState.value = cache;
  /**
   * Cross-session memory, through the SAME door every other role uses.
   *
   * Rules are appended to every role's prompt by the RoleRegistry, so only facts and lessons are selected
   * here. This used to call `selectMemories` directly and re-implement the bookkeeping around it — badly:
   * it recorded the injection-log cooldown and nothing else, so `recordInjection` never ran and the durable
   * "shown N times, never cited" count that memory hygiene prunes on had no data from the role the user
   * talks to most. The chat event and the telemetry record were missing for the same reason. A second
   * implementation of a shared step keeps only the parts whoever wrote it remembered.
   */
  const load = historyTokens(compacted) / COMPACT_MAX_TOKENS;
  const hints = memoryHints(deps, prompt, { load, role: "coach" });
  const memoryMsg: Message[] = hints.message ? [{ role: "user", content: hints.message }] : [];
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    fallbacks,
    systemPrompt: systemPrompt + context,
    onExhausted,
    onFallback,
    tools: readOnlyRegistry(deps, { remember: true, mcp: true, gitWrite: true }),
    remember: deps.rememberFact,
    messages: [...compacted, ...memoryMsg, { role: "user", content: prompt, ...(images?.length ? { images } : {}) }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
    inbox: deps.inbox, // "by-the-way" notes typed mid-run are folded into the coach's turn
    /**
     * What the coach says while it works, not only its verdict.
     *
     * A read-only exploration turn can run for minutes over a dozen tool calls, and until it finished the
     * screen held a spinner and nothing else — no way to tell a coach reading the right files from one that
     * is not, and no chance to redirect it before the tokens were spent.
     */
    // …but not the final message: the caller renders that as the reply.
    ...(deps.note ? { onSay: (t: string, final: boolean) => { if (!final) deps.note?.(t); } } : {}),
  };
  const msg = await runToCompletion(opts);
  // Reinforcement: bump the memories the reply actually cited so they rank higher on future ties. Through
  // the shared path, so the credit is recorded and reported the same way every other role's is.
  reinforceUsed(deps, hints.ids, msg.content, "coach");
  return msg.content;
}
