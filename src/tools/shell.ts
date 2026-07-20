import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../core/types.js";

const params = z.object({ command: z.string() });

export const shellTool: Tool = {
  name: "shell",
  description: "Bir shell komutu çalıştırır (cwd bağlamında). stdout+stderr ve çıkış kodunu döner.",
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
        content: `shell: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
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
          content: `shell hatası: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        });
        return;
      }
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        resolvePromise({ content: `shell hatası: ${e.message}`, isError: true });
      });
      child.on("close", (code) => {
        const body = [out, err].filter((s) => s.length).join("\n").trimEnd();
        resolvePromise({
          content: `$ ${a.command}\n${body}\n(exit ${code ?? "null"})`,
          isError: code !== 0,
        });
      });
    });
  },
};
