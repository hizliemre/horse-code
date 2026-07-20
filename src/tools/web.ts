import { z } from "zod";
import type { Tool } from "../core/types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const params = z.object({ url: z.string().url() });
const MAX_CHARS = 100_000;

export function createWebFetchTool(fetchFn: FetchLike = globalThis.fetch as FetchLike): Tool {
  return {
    name: "web_fetch",
    description: "Bir URL'nin içeriğini (metin) çeker.",
    permissionLevel: "safe",
    parameters: params,
    async run(rawArgs, ctx) {
      const parsed = params.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: `web_fetch: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        };
      }
      const a = parsed.data;
      try {
        const res = await fetchFn(a.url, { signal: ctx.signal });
        const text = await res.text();
        const capped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n… (kesildi)" : text;
        return { content: capped, isError: !res.ok };
      } catch (e) {
        return {
          content: `web_fetch hatası: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}
