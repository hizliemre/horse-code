import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Message, Provider } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { compactHistory, historyTokens } from "./compaction.js";
import { selectMemories, renderMemoryHints, memoryReferenced } from "./memory-retrieval.js";
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
  };
  const msg = await runToCompletion(opts);
  return msg.content;
}

/**
 * Coach chat: answers the prompt using read-only repo tools (read/grep/glob + skill); returns the final text.
 * `history` is the previous conversation turns (user/assistant) → multi-turn session consistency (the conversation progresses).
 */
export async function runCoachChat(deps: TaskCycleDeps, prompt: string, cwd: string, history: Message[] = [], language?: string, images?: string[]): Promise<string> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("coach");
  // The refined prompt is always English; tell the coach the real model + the user's original language so
  // "which model are you?" is answered truthfully and the reply comes back in the language the user used.
  const pins = deps.pins?.() ?? [];
  const pinBlock = pins.length ? `\n\nUser pins (always honor these):\n${pins.map((p) => `- ${p}`).join("\n")}` : "";
  const context = `\n\nContext: this session is powered by the "${model}" model.` +
    (language ? ` Respond in ${language}.` : "") +
    ` When it helps, end your reply with a <nextsteps> block: 2-4 short, concrete follow-up actions the` +
    ` user might pick next, one per line prefixed with "- ". Omit the block when there is no useful next step.` +
    ` If — and only if — the user states a DURABLE preference, decision, or project fact worth recalling in` +
    ` future sessions (e.g. "always use pnpm", "the API base is X", "we target Node 22"), also emit a` +
    ` <remember> block with 1-3 short, self-contained facts, one per line prefixed with "- ". Never remember` +
    ` transient, trivial, or one-off things.` +
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
  // Cross-session memory: surface facts relevant to this prompt, gated by how full the context already is.
  const memories = deps.memory?.() ?? [];
  const load = historyTokens(compacted) / COMPACT_MAX_TOKENS;
  const hits = memories.length ? selectMemories(memories, prompt, { load }) : [];
  const memoryMsg: Message[] = hits.length ? [{ role: "user", content: renderMemoryHints(hits) }] : [];
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    systemPrompt: systemPrompt + context,
    tools: readOnlyRegistry(deps, { remember: true, mcp: true }),
    remember: deps.rememberFact,
    messages: [...compacted, ...memoryMsg, { role: "user", content: prompt, ...(images?.length ? { images } : {}) }],
    permission: deps.permission,
    approve: deps.approve,
    cwd,
    signal: deps.signal,
    inbox: deps.inbox, // "by-the-way" notes typed mid-run are folded into the coach's turn
  };
  const msg = await runToCompletion(opts);
  // Reinforcement: bump the memories the reply actually cited so they rank higher on future ties.
  if (deps.reinforceMemory) for (const h of hits) if (memoryReferenced(h, msg.content)) deps.reinforceMemory(h.id);
  return msg.content;
}
