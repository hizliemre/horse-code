import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../core/types.js";

const params = z.object({ command: z.string() });

/**
 * Cap on how much command output enters the conversation (~8k tokens).
 *
 * A build or install log is tens of thousands of characters, and once it is in the conversation it is re-sent
 * on EVERY subsequent turn — a single `ng build` was being billed dozens of times over. What matters in a long
 * log is the START (what ran, early errors) and the END (the failure and the summary); the middle is noise.
 */
export const MAX_SHELL_CHARS = 32_000;
/** How much of the budget goes to the tail — the failure and the exit summary usually live there. */
const TAIL_SHARE = 0.6;

/** Trims a long log to its head and tail, saying plainly what was dropped. */
export function clampOutput(body: string, max = MAX_SHELL_CHARS): string {
  if (body.length <= max) return body;
  const tail = Math.floor(max * TAIL_SHARE);
  const head = max - tail;
  const dropped = body.length - max;
  const lines = body.slice(head, body.length - tail).split("\n").length;
  return `${body.slice(0, head)}\n\n… [${dropped.toLocaleString("en-US")} chars / ~${lines} lines trimmed from the middle] …\n\n${body.slice(-tail)}`;
}

export const shellTool: Tool = {
  name: "shell",
  description: "Runs a shell command (in the cwd context). Returns stdout+stderr and the exit code.",
  permissionLevel: "exec",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.command, preview: a.command };
  },
  run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return Promise.resolve({
        content: `shell: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      });
    }
    const a = parsed.data;
    return new Promise<ToolResult>((resolvePromise) => {
      let child;
      try {
        child = spawn(a.command, { cwd: ctx.cwd, shell: true, signal: ctx.signal });
      } catch (e) {
        resolvePromise({
          content: `shell error: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        });
        return;
      }
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        resolvePromise({ content: `shell error: ${e.message}`, isError: true });
      });
      child.on("close", (code) => {
        const body = clampOutput([out, err].filter((s) => s.length).join("\n").trimEnd());
        resolvePromise({
          content: `$ ${a.command}\n${body}\n(exit ${code ?? "null"})`,
          isError: code !== 0,
        });
      });
    });
  },
};
