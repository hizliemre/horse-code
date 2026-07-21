import type { z } from "zod";
import type { Tool } from "../core/types.js";
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

/**
 * Runs a role so it produces structured output: adds the submit tool to the role's
 * registry, drives runRoleAgent, and returns the validated object once a valid submit is captured.
 */
export async function runStructuredRole<T>(
  opts: RoleAgentOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const handle = buildSubmitTool(schema);
  const registry = new ToolRegistry();
  for (const t of opts.tools.list()) registry.register(t);
  registry.register(handle.tool);

  for await (const ev of runRoleAgent({ ...opts, tools: registry })) {
    if (ev.type === "error") throw new Error(ev.message);
    if (ev.type === "abort") throw new Error("cancelled");
    if (handle.result() !== undefined) break; // valid submit captured → exit early
  }

  const r = handle.result();
  if (r === undefined) throw new Error("structured role: submit was not called");
  return r.value;
}
