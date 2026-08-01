import type { ChatRequest, Provider } from "../core/types.js";

/**
 * What a message typed after an interrupted run actually means.
 *
 * Resuming used to be matched on the request being repeated word for word, or on a bare "continue". Anything
 * else opened a fresh session, silently, with the preserved work sitting next to it. Reported from a real
 * session: a wrong answer during brainstorming, Ctrl+C, then "don't add it to the todo, I answered wrongly,
 * we need to fix the problem" — and the pipeline started over from the constitution, 190k tokens in before
 * anything said so.
 *
 * A keyword test cannot read that, and neither can a yes/no question: the message was neither "carry on" nor
 * "start something else". It was "keep this work, the direction was wrong, here is the right one" — which is
 * a third thing, and the only reader that can tell the three apart is one that understands the sentence.
 */

export type ResumeMode =
  /** Carry on with the same request — the interruption was incidental. */
  | "resume"
  /** Keep the work, change the request: a correction to what was being done. */
  | "revise"
  /** Unrelated to the interrupted work — a new session. */
  | "new";

export interface ResumeIntent {
  mode: ResumeMode;
  /**
   * The request to run.
   *
   * For `revise` this is the ORIGINAL intent rewritten with the correction folded in — not the correction on
   * its own, which would read as a fragment ("don't add it to the todo") with the goal missing.
   */
  request: string;
  /** One short line, shown to the user: a resume they did not ask for must be explicable. */
  why: string;
}

const SYSTEM =
  "You classify what a user's message means after their previous request was interrupted. You are precise "
  + "and you never invent intent that is not in the message.";

const PROMPT = (interrupted: string, message: string): string =>
  `A request was running and the user stopped it. They then typed something else.\n\n`
  + `THE INTERRUPTED REQUEST:\n${interrupted}\n\nWHAT THEY TYPED NEXT:\n${message}\n\n`
  + `Classify the new message into exactly one of:\n`
  + `- "resume": it asks to carry on with the SAME request. The interruption was incidental.\n`
  + `- "revise": it keeps working on the same thing but CHANGES the direction — a correction, a "no, not `
  + `that", an answer given wrongly, a different approach for the same goal. The work done so far is still `
  + `wanted.\n`
  + `- "new": it is about something else entirely. The interrupted work is not being continued.\n\n`
  + `Then give the request to run:\n`
  + `- for "resume", the interrupted request, unchanged;\n`
  + `- for "revise", the interrupted request REWRITTEN so it states the corrected goal in full. It must stand `
  + `alone: someone reading only your rewrite must know what to build. Do not drop the original goal, and do `
  + `not keep the part the user rejected;\n`
  + `- for "new", the user's message, unchanged.\n\n`
  + `Also give one short sentence saying why, addressed to the user.\n\n`
  + `Answer with a fenced json block: {"mode":"resume|revise|new","request":"...","why":"..."}`;

function parse(text: string): ResumeIntent | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"));
  try {
    const p = JSON.parse(raw) as { mode?: unknown; request?: unknown; why?: unknown };
    const mode = p.mode === "resume" || p.mode === "revise" || p.mode === "new" ? p.mode : undefined;
    if (!mode || typeof p.request !== "string" || !p.request.trim()) return undefined;
    return { mode, request: p.request.trim(), why: typeof p.why === "string" ? p.why.trim() : "" };
  } catch {
    return undefined;
  }
}

/**
 * Asks a model what the follow-up meant. Returns undefined when it cannot say — the caller then asks the
 * user, which is the only honest fallback: guessing "new" restarts a project and guessing "resume" buries a
 * genuinely new request inside old work.
 */
export async function classifyResume(opts: {
  provider: Provider;
  models: string[];
  interrupted: string;
  message: string;
  signal?: AbortSignal;
}): Promise<ResumeIntent | undefined> {
  const chain = opts.models.filter(Boolean);
  for (const model of chain) {
    const req: ChatRequest = {
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: PROMPT(opts.interrupted, opts.message) },
      ],
      tools: [],
    };
    let out = "";
    try {
      for await (const ev of opts.provider.chat(req, opts.signal ?? new AbortController().signal)) {
        if (ev.type === "text-delta") out += ev.text;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    } catch {
      continue; // a spent model must not decide this — try the next in the chain
    }
    const parsed = parse(out);
    if (parsed) return parsed;
  }
  return undefined;
}
