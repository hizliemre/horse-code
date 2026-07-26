import { it } from "vitest";
import { readFileSync } from "node:fs";
import { discover } from "../src/migrate/discover.js";
import { classify } from "../src/migrate/extract.js";
import { OmniRouteProvider } from "../src/providers/omniroute.js";
it("ex", async () => {
  const cfg = JSON.parse(readFileSync(process.env.HOME + "/.horsecode/config.json", "utf8"));
  const provider = new OmniRouteProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const model = "cc/claude-opus-4-6";
  const p = (s: string) => process.stderr.write(`E ${s}\n`);
  const f = await discover({ cwd: "/Users/hizliemre/Desktop/HighBrains/parrot", home: process.env.HOME! });
  const claude = f.find((x) => x.label === "CLAUDE.md")!;
  p(`CLAUDE.md ${claude.bytes} B → sınıflandırılıyor`);
  const c = await classify({ provider, model, body: claude.text!, source: "CLAUDE.md" });
  for (const x of c) p(`  [${x.disposition.padEnd(4)}] ${x.text.slice(0, 78)}${x.disposition === "skip" ? `  ← ${x.reason}` : ""}`);
  p(`toplam ${c.length}: rule=${c.filter(x=>x.disposition==="rule").length} fact=${c.filter(x=>x.disposition==="fact").length} skip=${c.filter(x=>x.disposition==="skip").length}`);
}, 240_000);
