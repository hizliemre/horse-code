import type { z } from "zod";
import type { Message, Tool } from "../core/types.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";

export interface SubmitToolHandle<T> {
  tool: Tool;
  result(): { value: T } | undefined;
}

/**
 * Returns a "submit" tool whose parameters are the given zod schema, plus a capturing box.
 * When the model calls submit, the args are validated; if valid they're written to the box,
 * if invalid isError is returned.
 */
export function buildSubmitTool<T>(schema: z.ZodType<T>): SubmitToolHandle<T> {
  let box: { value: T } | undefined;
  const tool: Tool = {
    name: "submit",
    description: "When you are done, submit your result in structured form with this tool.",
    permissionLevel: "safe",
    parameters: schema,
    run: async (rawArgs) => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: `submit: invalid output: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        };
      }
      box = { value: parsed.data };
      return { content: "received", isError: false };
    },
  };
  return { tool, result: () => box };
}

/** Last resort: some models emit the JSON result in prose instead of calling submit → salvage it. */
function extractStructured<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const block = trimmed.match(/\{[\s\S]*\}/); // first {...} span (handles JSON wrapped in prose/fences)
  if (block) candidates.push(block[0]);
  for (const c of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON → try the next candidate
    }
  }
  return undefined;
}

/**
 * Runs a role so it produces structured output: adds the submit tool to the role's
 * registry, drives runRoleAgent, and returns the validated object once a valid submit is captured.
 *
 * Weaker models sometimes answer in prose/reasoning instead of calling submit. When a pass ends with no
 * valid submit we (1) try to salvage JSON from the final text, then (2) nudge the model to actually call
 * submit and retry — up to `maxAttempts` passes — before giving up.
 */
/**
 * A role that ran out of tool budget has not FAILED — it explored too long. Detected so the chain does not
 * treat it as a broken model and re-run the same work on every fallback.
 */
const TURN_LIMIT_RE = /maximum turn count exceeded/i;

export async function runStructuredRole<T>(
  opts: RoleAgentOptions,
  schema: z.ZodType<T>,
  // Two nudges per model, not three: with a 3-model chain that is 6 full passes instead of 9, and the third
  // nudge almost never converted a model that had already ignored `submit` twice — it just re-sent the whole
  // (by then very large) conversation one more time.
  maxAttempts = 2,
): Promise<T> {
  const handle = buildSubmitTool(schema);
  const registry = new ToolRegistry();
  for (const t of opts.tools.list()) registry.register(t);
  registry.register(handle.tool);

  // Walk the FULL model chain (primary + fallbacks), not just the primary: a model that errors OR answers in
  // prose (never calls submit) must not doom the role while its fallback models sit idle. Each model gets
  // `maxAttempts` nudge-retries; on a hard error or persistent no-submit we fall to the next model. Only when
  // EVERY model in the chain has failed do we give up. (runRoleAgent is driven per-model with fallbacks:[] so
  // THIS loop owns the chain walk — otherwise a retryable error would skip models out from under it.)
  const chain = [opts.model, ...(opts.fallbacks ?? [])];
  let lastError: string | undefined; // most recent hard error → preserved so the final throw is informative
  for (let ci = 0; ci < chain.length; ci++) {
    const model = chain[ci];
    if (ci > 0) opts.onFallback?.(chain[ci - 1], model, "structured: previous model returned no valid result");
    const messages: Message[] = [...opts.messages]; // fresh conversation for each model
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let lastText = "";
      let errored: string | undefined;
      for await (const ev of runRoleAgent({ ...opts, model, fallbacks: [], messages, tools: registry })) {
        if (ev.type === "error") { errored = ev.message; break; }
        if (ev.type === "abort") throw new Error("cancelled");
        // NB: runRoleAgent reports usage itself (it knows which chain link actually served the call), so
        // forwarding the yielded event here too would double-count every reviewer's tokens.
        if (ev.type === "message.done") lastText = ev.message.content ?? lastText;
        if (handle.result() !== undefined) break; // valid submit captured → exit early
      }
      const r = handle.result();
      if (r !== undefined) return r.value;

      const salvaged = extractStructured(lastText, schema);
      if (salvaged !== undefined) return salvaged;

      if (errored !== undefined) {
        // Out of turns is not a model defect: the conversation already holds everything it read. Ask it to
        // submit what it has instead of discarding the work and repeating it on the next model.
        if (TURN_LIMIT_RE.test(errored) && attempt < maxAttempts - 1) {
          messages.push({ role: "assistant", content: lastText });
          messages.push({ role: "user", content:
            "You have used your entire tool-call budget. Call `submit` NOW with the findings you already have. " +
            "Do not read, grep or inspect anything else." });
          continue;
        }
        lastError = errored; break; // a genuine model error → stop nudging, try the next model
      }
      // Prose instead of a tool call → nudge THIS model to call submit, then retry it.
      messages.push({ role: "assistant", content: lastText });
      messages.push({
        role: "user",
        content:
          "You did not call the `submit` tool. Call `submit` now with your result as structured arguments — do not answer in prose.",
      });
    }
    if (opts.signal.aborted) throw new Error("cancelled");
    // this model won't produce a valid result → the outer loop moves to the next model in the chain
  }

  // Every model in the chain failed: surface the last hard error if there was one, else the no-submit message.
  throw new Error(lastError ?? "structured role: submit was not called (whole model chain tried)");
}
