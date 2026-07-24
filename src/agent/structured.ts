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
export async function runStructuredRole<T>(
  opts: RoleAgentOptions,
  schema: z.ZodType<T>,
  maxAttempts = 3,
): Promise<T> {
  const handle = buildSubmitTool(schema);
  const registry = new ToolRegistry();
  for (const t of opts.tools.list()) registry.register(t);
  registry.register(handle.tool);

  const messages: Message[] = [...opts.messages];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let lastText = "";
    for await (const ev of runRoleAgent({ ...opts, messages, tools: registry })) {
      if (ev.type === "error") throw new Error(ev.message);
      if (ev.type === "abort") throw new Error("cancelled");
      if (ev.type === "usage") opts.onUsage?.({ promptTokens: ev.promptTokens, completionTokens: ev.completionTokens });
      if (ev.type === "message.done") lastText = ev.message.content ?? lastText;
      if (handle.result() !== undefined) break; // valid submit captured → exit early
    }
    const r = handle.result();
    if (r !== undefined) return r.value;

    const salvaged = extractStructured(lastText, schema);
    if (salvaged !== undefined) return salvaged;

    // No submit and nothing to salvage → nudge the model to call submit, then retry.
    messages.push({ role: "assistant", content: lastText });
    messages.push({
      role: "user",
      content:
        "You did not call the `submit` tool. Call `submit` now with your result as structured arguments — do not answer in prose.",
    });
  }

  throw new Error("structured role: submit was not called");
}
