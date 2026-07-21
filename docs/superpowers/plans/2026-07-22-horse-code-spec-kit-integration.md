# horse-code'a Yerleşik spec-kit Entegrasyonu — Implementasyon Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec-kit'in Spec-Driven Development akışını (constitution→specify→clarify→plan→tasks) horse-code'a yerleşik hale getirmek; template içeriği spec-kit'ten senkron, interaktif Q&A ile spec olgunlaştırma.

**Architecture:** spec-kit template'leri pinli tag'den (`v0.13.2`) `raw.githubusercontent.com`'dan çekilir + `~/.horsecode/spec-kit/<tag>/` cache'lenir. Yeni `src/speckit/*` modülleri (templates fetcher, layout/scaffolding, phases, clarify) horse-code'un mevcut rol/tool desenlerini kullanarak fazları sürer. `upstream.ts` pipeline'ı bu fazlara yönlendirilir; `refiner`, council/judge review loop ve `waves/implement` korunur.

**Tech Stack:** TypeScript (ESM), Node fs, `FetchLike` (omniroute deseni), zod, Vitest, MockProvider.

## Global Constraints

- Kodda/comment/test-adı/UI **ASLA Türkçe** — hepsi İngilizce. (Docs/spec/plan Türkçe kalır.)
- Harici runtime bağımlılığı YOK (Python/uvx yok); sadece HTTP fetch + fs.
- Template kaynağı: `https://raw.githubusercontent.com/github/spec-kit/<version>/templates/<path>`. Varsayılan pin: **`v0.13.2`**.
- Template dosyaları: `spec-template.md`, `plan-template.md`, `tasks-template.md`, `constitution-template.md`, `checklist-template.md`. Komut dosyaları (`commands/` altında): `constitution.md`, `specify.md`, `clarify.md`, `plan.md`, `tasks.md` (`speckit.` öneki YOK).
- Cache dizini: `<home>/.horsecode/spec-kit/<version>/templates/…`. Dosya cache'te varsa ağ çağrısı yapılmaz.
- Artifact düzeni: `<workdir>/.specify/memory/constitution.md` + `<workdir>/specs/<NNN-slug>/{spec,plan,tasks}.md`.
- clarify üst sınırı: **5 tur**. Sonsuz Q&A yok.
- Testler `FetchLike`/`MockProvider` ile deterministik; ağ yok.
- Her task sonunda `npm run typecheck` + ilgili testler yeşil + commit.

---

### Task 1: Config'e `specKit.version` alanı

**Files:**
- Modify: `src/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Produces: `ResolvedConfig.specKit?: { version: string }`; `DEFAULT_CONFIG.specKit = { version: "v0.13.2" }`.

- [ ] **Step 1: Write the failing test**

`test/config/config.test.ts` içine ekle:
```ts
it("defaults specKit.version and reads it from a file", () => {
  const cfg = loadConfig({
    cwd: "/x", home: "/h", env: {},
    readFile: (p) => (p === "/h/.horsecode/config.json" ? '{"specKit":{"version":"v0.14.0"}}' : undefined),
  });
  expect(cfg.specKit.version).toBe("v0.14.0");
});

it("specKit falls back to the default version when absent", () => {
  const cfg = loadConfig({ cwd: "/x", home: "/h", env: {}, readFile: () => undefined });
  expect(cfg.specKit.version).toBe("v0.13.2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL (`specKit` undefined).

- [ ] **Step 3: Implement**

`src/config/config.ts`:
- `ResolvedConfig` içine ekle: `specKit: { version: string };`
- `DEFAULT_CONFIG` içine ekle: `specKit: { version: "v0.13.2" },`
- `fileSchema` içine ekle:
  ```ts
  specKit: z.object({ version: z.string() }).optional(),
  ```
- `loadConfig` merged sonrası (env bloğundan önce) ekle:
  ```ts
  merged.specKit = projectSafe.specKit ?? global.specKit ?? DEFAULT_CONFIG.specKit;
  ```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/config/config.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts test/config/config.test.ts
git commit -m "feat: config specKit.version (default v0.13.2)"
```

---

### Task 2: Template fetcher — `src/speckit/templates.ts`

**Files:**
- Create: `src/speckit/templates.ts`
- Test: `test/speckit/templates.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `../providers/omniroute.js`.
- Produces:
  ```ts
  export interface SpecKitTemplates {
    version: string;
    template(name: "spec" | "plan" | "tasks" | "constitution" | "checklist"): string;
    command(name: "constitution" | "specify" | "clarify" | "plan" | "tasks"): string;
  }
  export function loadSpecKit(opts: { version: string; home: string; fetch?: FetchLike }): Promise<SpecKitTemplates>;
  ```

- [ ] **Step 1: Write the failing test**

`test/speckit/templates.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpecKit } from "../../src/speckit/templates.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-sk-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const okFetch = (calls: string[]): FetchLike => async (url) => {
  calls.push(url);
  return new Response(`BODY ${url}`, { status: 200 });
};

describe("loadSpecKit", () => {
  it("fetches every template + command, exposes them, and caches to disk", async () => {
    const calls: string[] = [];
    const sk = await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch(calls) });
    expect(sk.version).toBe("v9.9.9");
    expect(sk.template("spec")).toContain("spec-template.md");
    expect(sk.command("clarify")).toContain("commands/clarify.md");
    expect(calls).toHaveLength(10); // 5 templates + 5 commands
    expect(calls[0]).toBe("https://raw.githubusercontent.com/github/spec-kit/v9.9.9/templates/spec-template.md");
    // cache written
    const cached = await readFile(join(home, ".horsecode/spec-kit/v9.9.9/templates/spec-template.md"), "utf8");
    expect(cached).toContain("spec-template.md");
  });

  it("reads from cache on the second load (no network)", async () => {
    await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch([]) });
    const calls: string[] = [];
    const sk = await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch(calls) });
    expect(calls).toHaveLength(0); // fully cached
    expect(sk.template("plan")).toContain("plan-template.md");
  });

  it("throws an actionable error when a fetch fails and there is no cache", async () => {
    const bad: FetchLike = async () => new Response("nope", { status: 404 });
    await expect(loadSpecKit({ version: "v0.0.0", home, fetch: bad })).rejects.toThrow(/spec-kit template fetch failed \(404\)/);
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`npx vitest run test/speckit/templates.test.ts`, module missing).

- [ ] **Step 3: Implement `src/speckit/templates.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FetchLike } from "../providers/omniroute.js";

const TEMPLATE_FILES = {
  spec: "spec-template.md",
  plan: "plan-template.md",
  tasks: "tasks-template.md",
  constitution: "constitution-template.md",
  checklist: "checklist-template.md",
} as const;
const COMMAND_FILES = {
  constitution: "commands/constitution.md",
  specify: "commands/specify.md",
  clarify: "commands/clarify.md",
  plan: "commands/plan.md",
  tasks: "commands/tasks.md",
} as const;

type TemplateName = keyof typeof TEMPLATE_FILES;
type CommandName = keyof typeof COMMAND_FILES;

export interface SpecKitTemplates {
  version: string;
  template(name: TemplateName): string;
  command(name: CommandName): string;
}

const RAW_BASE = "https://raw.githubusercontent.com/github/spec-kit";

/** Loads spec-kit templates for a pinned tag: serves from the on-disk cache, fetching any missing file once. */
export async function loadSpecKit(opts: {
  version: string;
  home: string;
  fetch?: FetchLike;
}): Promise<SpecKitTemplates> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const cacheDir = join(opts.home, ".horsecode", "spec-kit", opts.version, "templates");

  const get = async (relPath: string): Promise<string> => {
    const cachePath = join(cacheDir, relPath);
    if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");
    const url = `${RAW_BASE}/${opts.version}/templates/${relPath}`;
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(
        `spec-kit template fetch failed (${res.status}): ${url}\n` +
          `Check your network or set specKit.version to a valid tag.`,
      );
    }
    const text = await res.text();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, text, "utf8");
    return text;
  };

  const templates: Record<string, string> = {};
  for (const [name, file] of Object.entries(TEMPLATE_FILES)) templates[name] = await get(file);
  const commands: Record<string, string> = {};
  for (const [name, file] of Object.entries(COMMAND_FILES)) commands[name] = await get(file);

  return {
    version: opts.version,
    template: (name) => templates[name],
    command: (name) => commands[name],
  };
}
```

- [ ] **Step 4: Run test → PASS**; `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/speckit/templates.ts test/speckit/templates.test.ts
git commit -m "feat: spec-kit template fetcher (pinned tag + on-disk cache, no Python)"
```

---

### Task 3: Layout + scaffolding — `src/speckit/layout.ts`

**Files:**
- Create: `src/speckit/layout.ts`
- Test: `test/speckit/layout.test.ts`

**Interfaces:**
- Consumes: `toSlug` from `../worktree/slug.js`.
- Produces:
  ```ts
  export interface FeaturePaths { dir: string; spec: string; plan: string; tasks: string }
  export function specsDir(workdir: string): string;
  export function constitutionPath(workdir: string): string;
  export function featurePaths(workdir: string, slug: string): FeaturePaths;
  export function nextFeatureSlug(workdir: string, title: string): string;
  export function scaffoldFeature(workdir: string, slug: string): FeaturePaths;
  ```

- [ ] **Step 1: Write the failing test**

`test/speckit/layout.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextFeatureSlug, featurePaths, constitutionPath, scaffoldFeature } from "../../src/speckit/layout.js";

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-lay-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("layout", () => {
  it("nextFeatureSlug starts at 001 in an empty workdir", () => {
    expect(nextFeatureSlug(wd, "add login page")).toBe("001-add-login-page");
  });

  it("nextFeatureSlug increments past existing NNN- dirs", async () => {
    await mkdir(join(wd, "specs", "001-foo"), { recursive: true });
    await mkdir(join(wd, "specs", "002-bar"), { recursive: true });
    expect(nextFeatureSlug(wd, "fix null crash on submit here")).toBe("003-fix-null-crash-on-submit");
  });

  it("featurePaths + constitutionPath produce the spec-kit layout", () => {
    const p = featurePaths(wd, "001-x");
    expect(p.spec.endsWith("specs/001-x/spec.md")).toBe(true);
    expect(p.plan.endsWith("specs/001-x/plan.md")).toBe(true);
    expect(p.tasks.endsWith("specs/001-x/tasks.md")).toBe(true);
    expect(constitutionPath(wd).endsWith(".specify/memory/constitution.md")).toBe(true);
  });

  it("scaffoldFeature creates the feature + .specify/memory dirs", () => {
    scaffoldFeature(wd, "001-x");
    expect(existsSync(join(wd, "specs", "001-x"))).toBe(true);
    expect(existsSync(join(wd, ".specify", "memory"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/speckit/layout.ts`**

```ts
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toSlug } from "../worktree/slug.js";

export interface FeaturePaths { dir: string; spec: string; plan: string; tasks: string }

export function specsDir(workdir: string): string {
  return join(workdir, "specs");
}

export function constitutionPath(workdir: string): string {
  return join(workdir, ".specify", "memory", "constitution.md");
}

export function featurePaths(workdir: string, slug: string): FeaturePaths {
  const dir = join(specsDir(workdir), slug);
  return { dir, spec: join(dir, "spec.md"), plan: join(dir, "plan.md"), tasks: join(dir, "tasks.md") };
}

/** Next feature slug "NNN-title": zero-padded, one past the highest existing specs/NNN- dir. */
export function nextFeatureSlug(workdir: string, title: string): string {
  const dir = specsDir(workdir);
  let max = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^(\d+)-/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${String(max + 1).padStart(3, "0")}-${toSlug(title)}`;
}

/** Creates the .specify/memory + specs/<slug> directories; returns the feature paths. */
export function scaffoldFeature(workdir: string, slug: string): FeaturePaths {
  const paths = featurePaths(workdir, slug);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(join(workdir, ".specify", "memory"), { recursive: true });
  return paths;
}
```

- [ ] **Step 4: Run → PASS; `npm run typecheck`.**

- [ ] **Step 5: Commit**

```bash
git add src/speckit/layout.ts test/speckit/layout.test.ts
git commit -m "feat: spec-kit artifact layout + feature numbering (TS scaffolding)"
```

---

### Task 4: Phases — `src/speckit/phases.ts` (constitution/specify/plan/tasks)

**Files:**
- Create: `src/speckit/phases.ts`
- Test: `test/speckit/phases.test.ts`

**Interfaces:**
- Consumes: `TaskCycleDeps` (`../engine/task-types.js`), `SpecKitTemplates`, `FeaturePaths`, `AskUser` (`../engine/review.js`), tool builders (`readFileTool`, `writeFileTool`, `editFileTool`, `grepTool`, `globTool`), `buildAskUserTool` (Task 4 re-exports it from a shared spot — see note), `runToCompletion`, `RoleAgentOptions`.
- Produces:
  ```ts
  export interface PhaseDeps { deps: TaskCycleDeps; templates: SpecKitTemplates; workdir: string }
  export function runConstitution(p: PhaseDeps, askUser: AskUser): Promise<void>;
  export function runSpecify(p: PhaseDeps, paths: FeaturePaths, prompt: string, feedback?: string[]): Promise<void>;
  export function runPlan(p: PhaseDeps, paths: FeaturePaths, feedback?: string[]): Promise<void>;
  export function runTasks(p: PhaseDeps, paths: FeaturePaths): Promise<void>;
  ```

**Note (shared helpers):** To avoid a circular import (`upstream.ts` → `phases.ts` → `upstream.ts`), move `buildAskUserTool` and `writerRegistry` into a new `src/engine/writer-registry.ts` and have both `upstream.ts` and `phases.ts` import from it. This task creates that module.

- [ ] **Step 1: Extract shared helpers into `src/engine/writer-registry.ts`**

```ts
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { AskUser } from "./review.js";

const askUserParams = z.object({ question: z.string() });

/** Tool for a role to ask the user a question; returns the answer in content. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description: "Ask the user a question and get their answer.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      return { content: await askUser(parsed.data.question), isError: false };
    },
  };
}

/** read/write/edit/grep/glob + skill (+ extra); NO shell/web. */
export function writerRegistry(skillRegistry: SkillRegistry, extra: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(skillRegistry));
  for (const t of extra) r.register(t);
  return r;
}
```

Then update `src/engine/upstream.ts`: delete its local `askUserParams`, `buildAskUserTool`, `writerRegistry`; `import { buildAskUserTool, writerRegistry } from "./writer-registry.js";` and change `writerRegistry(deps, extra)` call-sites to `writerRegistry(deps.skillRegistry, extra)`. Re-export for back-compat if any test imports it from upstream: `export { buildAskUserTool } from "./writer-registry.js";`.

- [ ] **Step 2: Write the failing test** `test/speckit/phases.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecify, runConstitution } from "../../src/speckit/phases.js";
import { scaffoldFeature, constitutionPath } from "../../src/speckit/layout.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { ChatEvent } from "../../src/core/types.js";
import type { SpecKitTemplates } from "../../src/speckit/templates.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const fakeTemplates: SpecKitTemplates = {
  version: "test",
  template: (n) => `TEMPLATE:${n}`,
  command: (n) => `COMMAND:${n}`,
};
function deps(p: MockProvider): TaskCycleDeps {
  const roles = { analyst: { models: ["m"], systemPrompt: "a" }, planner: { models: ["m"], systemPrompt: "p" }, "project-manager": { models: ["m"], systemPrompt: "t" } };
  return {
    provider: p,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
const writeTurn = (path: string, content: string): ChatEvent[] => [
  { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
  { type: "done", finishReason: "tool_calls" },
];

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-ph-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("spec-kit phases", () => {
  it("runSpecify writes spec.md via the role using the spec-kit command + template", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    const p = new MockProvider([writeTurn(paths.spec, "# Spec\nok"), [{ type: "done", finishReason: "stop" }]]);
    await runSpecify({ deps: deps(p), templates: fakeTemplates, workdir: wd }, paths, "Build X");
    expect(await readFile(paths.spec, "utf8")).toContain("# Spec");
    // the spec-kit command + template were handed to the model
    const sys = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    const usr = JSON.stringify(p.requests[0].messages);
    expect(sys).toContain("COMMAND:specify");
    expect(usr).toContain("TEMPLATE:spec");
  });

  it("runConstitution writes the constitution file", async () => {
    scaffoldFeature(wd, "001-x");
    const cp = constitutionPath(wd);
    const p = new MockProvider([writeTurn(cp, "# Constitution"), [{ type: "done", finishReason: "stop" }]]);
    await runConstitution({ deps: deps(p), templates: fakeTemplates, workdir: wd }, async () => "answer");
    expect(existsSync(cp)).toBe(true);
  });
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement `src/speckit/phases.ts`**

```ts
import { relative } from "node:path";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { writerRegistry, buildAskUserTool } from "../engine/writer-registry.js";
import type { TaskCycleDeps } from "../engine/task-types.js";
import type { AskUser } from "../engine/review.js";
import type { SpecKitTemplates } from "./templates.js";
import type { FeaturePaths } from "./layout.js";
import { constitutionPath } from "./layout.js";

export interface PhaseDeps { deps: TaskCycleDeps; templates: SpecKitTemplates; workdir: string }

// Common framing: spec-kit command prompts assume bash scaffolding scripts; horse-code already scaffolds
// the workspace, so the role must skip those and just write the target file with write_file.
const SKIP = "The workspace is already scaffolded — do NOT run any shell scripts. Use write_file to write the output file exactly at the path given below.";

async function runRole(p: PhaseDeps, role: string, command: string, message: string, extraTools = false): Promise<void> {
  const { model } = p.deps.roleRegistry.resolve(role);
  const tools = writerRegistry(p.deps.skillRegistry, extraTools ? [buildAskUserTool(askUserOf(p))] : []);
  const opts: RoleAgentOptions = {
    provider: p.deps.provider,
    model,
    systemPrompt: `${command}\n\n${SKIP}`,
    tools,
    messages: [{ role: "user", content: message }],
    permission: p.deps.permission,
    approve: p.deps.approve,
    cwd: p.workdir,
    signal: p.deps.signal,
  };
  await runToCompletion(opts);
}

// askUser is only threaded into constitution/specify; a module-level holder keeps runRole generic.
let currentAskUser: AskUser = async () => "";
function askUserOf(_p: PhaseDeps): AskUser { return currentAskUser; }

export async function runConstitution(p: PhaseDeps, askUser: AskUser): Promise<void> {
  currentAskUser = askUser;
  const rel = relative(p.workdir, constitutionPath(p.workdir));
  const msg =
    `Establish the project constitution. Ask the user about core principles with ask_user if needed.\n` +
    `Follow this template:\n\n${p.templates.template("constitution")}\n\nWrite it to "${rel}".`;
  await runRole(p, "analyst", p.templates.command("constitution"), msg, true);
}

export async function runSpecify(p: PhaseDeps, paths: FeaturePaths, prompt: string, feedback?: string[]): Promise<void> {
  currentAskUser = askUserOf(p) === undefined ? currentAskUser : currentAskUser;
  const rel = relative(p.workdir, paths.spec);
  const msg = feedback?.length
    ? `Revise the spec at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}\nOriginal request: ${prompt}`
    : `Feature request: "${prompt}". Ask clarifying questions with ask_user only if strictly necessary.\n` +
      `Follow this template:\n\n${p.templates.template("spec")}\n\nWrite the spec to "${rel}".`;
  await runRole(p, "analyst", p.templates.command("specify"), msg, true);
}

export async function runPlan(p: PhaseDeps, paths: FeaturePaths, feedback?: string[]): Promise<void> {
  const rel = relative(p.workdir, paths.plan);
  const specRel = relative(p.workdir, paths.spec);
  const cRel = relative(p.workdir, constitutionPath(p.workdir));
  const msg = feedback?.length
    ? `Revise the plan at "${rel}" with these reviewer notes:\n${feedback.map((f) => `- ${f}`).join("\n")}`
    : `Read the spec "${specRel}" and the constitution "${cRel}" (if present).\n` +
      `Follow this template:\n\n${p.templates.template("plan")}\n\nWrite the plan to "${rel}".`;
  await runRole(p, "planner", p.templates.command("plan"), msg);
}

export async function runTasks(p: PhaseDeps, paths: FeaturePaths): Promise<void> {
  const rel = relative(p.workdir, paths.tasks);
  const planRel = relative(p.workdir, paths.plan);
  const msg =
    `Read the plan "${planRel}" and break it into an actionable task list.\n` +
    `Follow this template:\n\n${p.templates.template("tasks")}\n\nWrite the tasks to "${rel}".`;
  await runRole(p, "project-manager", p.templates.command("tasks"), msg);
}
```

> Implementer note: the module-level `currentAskUser` is a simplification; if the reviewer prefers, thread `askUser` explicitly through `PhaseDeps` instead. Either is acceptable as long as ask_user reaches the tool.

- [ ] **Step 5: Run → PASS; `npm run typecheck`; full `npx vitest run` (upstream tests still green after the writer-registry extraction).**

- [ ] **Step 6: Commit**

```bash
git add src/speckit/phases.ts src/engine/writer-registry.ts src/engine/upstream.ts test/speckit/phases.test.ts
git commit -m "feat: spec-kit phases (constitution/specify/plan/tasks) via horse-code roles"
```

---

### Task 5: Clarify Q&A loop — `src/speckit/clarify.ts`

**Files:**
- Create: `src/speckit/clarify.ts`
- Test: `test/speckit/clarify.test.ts`

**Interfaces:**
- Consumes: `PhaseDeps`, `FeaturePaths`, `AskUser`, `runStructuredRole`, `writerRegistry`.
- Produces:
  ```ts
  export const ClarifyStepSchema; // { nextQuestion: string | null }
  export function runClarify(p: PhaseDeps, paths: FeaturePaths, askUser: AskUser, maxRounds?: number): Promise<void>;
  ```

**Behavior:** Up to `maxRounds` (default 5) turns. Each turn: the role reads spec.md, either asks ONE clarifying question (`nextQuestion`) or signals completion (`nextQuestion: null`). The controller asks the user (one at a time via the pending UI), appends the Q+A to the running context, and the role updates spec.md (edit/write) before the next turn. Stops on `null` or when `maxRounds` is hit.

- [ ] **Step 1: Write the failing test** `test/speckit/clarify.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClarify } from "../../src/speckit/clarify.js";
import { scaffoldFeature } from "../../src/speckit/layout.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { ChatEvent } from "../../src/core/types.js";
import type { SpecKitTemplates } from "../../src/speckit/templates.js";

const templates: SpecKitTemplates = { version: "t", template: () => "T", command: () => "C" };
function deps(p: MockProvider) {
  return {
    provider: p,
    roleRegistry: new RoleRegistry({ analyst: { models: ["m"], systemPrompt: "a" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
const ask = (q: string | null): ChatEvent[] => [
  { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ nextQuestion: q }) } },
  { type: "done", finishReason: "tool_calls" },
];

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-cl-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("runClarify", () => {
  it("asks questions one at a time; the user's answers reach the model; stops on null", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    await writeFile(paths.spec, "# Spec", "utf8");
    const p = new MockProvider([ask("Which DB?"), ask(null)]);
    const asked: string[] = [];
    await runClarify({ deps: deps(p), templates, workdir: wd }, paths, async (q) => { asked.push(q); return "Postgres"; });
    expect(asked).toEqual(["Which DB?"]);
    // the answer was fed back into the second turn's context
    expect(JSON.stringify(p.requests[1].messages)).toContain("Postgres");
  });

  it("stops after maxRounds even if the model keeps asking", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    await writeFile(paths.spec, "# Spec", "utf8");
    const p = new MockProvider([ask("q1"), ask("q2"), ask("q3")]);
    let n = 0;
    await runClarify({ deps: deps(p), templates, workdir: wd }, paths, async () => { n++; return "a"; }, 2);
    expect(n).toBe(2); // capped
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/speckit/clarify.ts`**

```ts
import { relative } from "node:path";
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { writerRegistry } from "../engine/writer-registry.js";
import type { AskUser } from "../engine/review.js";
import type { PhaseDeps } from "./phases.js";
import type { FeaturePaths } from "./layout.js";

export const ClarifyStepSchema = z.object({
  // The single most important clarifying question, or null when the spec is sufficiently clear.
  nextQuestion: z.string().nullable(),
});

/**
 * Structured clarify loop: each round the role reads the spec and returns ONE question (or null to finish).
 * The user's answer is fed back; the role updates the spec before the next round. Capped at `maxRounds`.
 */
export async function runClarify(p: PhaseDeps, paths: FeaturePaths, askUser: AskUser, maxRounds = 5): Promise<void> {
  const specRel = relative(p.workdir, paths.spec);
  const { model } = p.deps.roleRegistry.resolve("analyst");
  const qa: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const context = qa.length ? `\n\nAnswers so far:\n${qa.join("\n")}` : "";
    const opts: RoleAgentOptions = {
      provider: p.deps.provider,
      model,
      systemPrompt: `${p.templates.command("clarify")}\n\nAsk at most one question per turn.`,
      tools: writerRegistry(p.deps.skillRegistry),
      messages: [{
        role: "user",
        content:
          `Read the spec "${specRel}". Identify the single most important underspecified point and return it as ` +
          `nextQuestion, or null if the spec is clear enough. If you already have an answer below, first update ` +
          `the spec at "${specRel}" (write_file/edit_file) to incorporate it, then decide the next question.${context}`,
      }],
      permission: p.deps.permission,
      approve: p.deps.approve,
      cwd: p.workdir,
      signal: p.deps.signal,
    };
    const step = await runStructuredRole(opts, ClarifyStepSchema);
    if (!step.nextQuestion) return;
    const answer = await askUser(step.nextQuestion);
    qa.push(`Q: ${step.nextQuestion}\nA: ${answer}`);
  }
}
```

- [ ] **Step 4: Run → PASS; `npm run typecheck`.**

- [ ] **Step 5: Commit**

```bash
git add src/speckit/clarify.ts test/speckit/clarify.test.ts
git commit -m "feat: spec-kit clarify — one-question-at-a-time Q&A loop (capped at 5)"
```

---

### Task 6: Wire spec-kit templates into JobDeps

**Files:**
- Modify: `src/engine/task-types.ts` (add `specKit?: SpecKitTemplates` to the deps carried through the pipeline), `src/wiring.ts` (load templates), `src/cli.ts` (pass home + version), `src/tui/app.tsx` (RunTui/Repl already builds deps)
- Test: `test/wiring.test.ts`

**Interfaces:**
- Produces: `JobDeps.specKit: SpecKitTemplates` (non-optional in the built deps; the pipeline needs it for feature work).

- [ ] **Step 1: Write the failing test** — assert `buildJobDeps` (or a new async `buildJobDepsWithSpecKit`) attaches `specKit`.

Because `buildJobDeps` is currently sync and `loadSpecKit` is async, add an async wrapper:
```ts
// wiring.ts
export async function buildJobDeps(opts: BuildJobDepsOpts): Promise<JobDeps> { ... const specKit = await loadSpecKit({ version: opts.config.specKit.version, home: opts.home, fetch: opts.fetch }); ... return { ...deps, specKit }; }
```
Add `home: string` and optional `fetch?: FetchLike` to `BuildJobDepsOpts`. Update `src/cli.ts` `buildDeps` to `await buildJobDeps({ ..., home })` (it becomes async — thread through `runTuiRepl`/`runTui` which already `await` the deps build, or build deps once before rendering). Test with a fake `fetch` returning 200 bodies.

- [ ] **Step 2–4:** implement, typecheck, run full suite (the deps-build call sites in `cli.ts`, `app.tsx` become async — adjust `buildDeps: (read) => JobDeps` to `(read) => Promise<JobDeps>` and `await` at call sites).

- [ ] **Step 5: Commit**
```bash
git commit -am "feat: load spec-kit templates into JobDeps (async wiring)"
```

---

### Task 7: Rewire the upstream pipeline to the spec-kit phases

**Files:**
- Modify: `src/engine/upstream.ts`, `src/engine/job.ts`
- Test: `test/engine/upstream.test.ts`

**Interfaces:**
- `UpstreamResult` "approved" gains `tasksPath`: `{ …; kind: "approved"; specPath: string; planPath: string; tasksPath: string }` (paths relative to the worktree).

- [ ] **Step 1: Write the failing test** (extends existing upstream tests):
```ts
it("feature intent runs the spec-kit pipeline: constitution (if missing) + specify + clarify + plan + tasks", async () => {
  // MockProvider scripted: refiner submit(feature,title) → constitution write → specify write → clarify null
  //   → council/judge pass (or stub review) → plan write → tasks write.
  // Assert: .specify/memory/constitution.md, specs/001-<slug>/{spec,plan,tasks}.md exist; result.kind === "approved".
});
```
(Use the existing upstream-test harness; stub the review loop to pass on the first round as the current tests do.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — replace the feature/bugfix branch of `runUpstream`:
```ts
  const workdir = await ensureWorktree(r.title);
  const p = { deps, templates: deps.specKit, workdir };
  if (!existsSync(constitutionPath(workdir))) {
    emit({ kind: "phase", phase: "constitution" });
    await runConstitution(p, askUser);
  }
  const slug = nextFeatureSlug(workdir, r.title);
  const paths = scaffoldFeature(workdir, slug);

  emit({ kind: "phase", phase: "specify" });
  await runSpecify(p, paths, r.refinedPrompt);
  const specRel = relative(workdir, paths.spec);
  const specOut = await runReviewLoop(deps, workdir, specRel, (fb) => runSpecify(p, paths, r.refinedPrompt, fb), askUser, maxRounds);
  if (!specOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "spec" };
  if (!existsSync(paths.spec)) throw new Error(`specify did not produce a spec: ${specRel}`);

  emit({ kind: "phase", phase: "clarify" });
  await runClarify(p, paths, askUser);

  emit({ kind: "phase", phase: "plan" });
  await runPlan(p, paths);
  const planRel = relative(workdir, paths.plan);
  const planOut = await runReviewLoop(deps, workdir, planRel, (fb) => runPlan(p, paths, fb), askUser, maxRounds);
  if (!planOut.approved) return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "rejected", stage: "plan" };
  if (!existsSync(paths.plan)) throw new Error(`plan did not produce a plan: ${planRel}`);

  emit({ kind: "phase", phase: "tasks" });
  await runTasks(p, paths);
  return { intent: r.intent, refinedPrompt: r.refinedPrompt, kind: "approved", specPath: specRel, planPath: planRel, tasksPath: relative(workdir, paths.tasks) };
```
Add imports: `constitutionPath, nextFeatureSlug, scaffoldFeature, featurePaths` from `../speckit/layout.js`; `runConstitution, runSpecify, runPlan, runTasks` from `../speckit/phases.js`; `runClarify` from `../speckit/clarify.js`; `relative` from `node:path`. Remove `runAnalyst`/`runPlanner` (or keep them unused-exported if other tests import them — delete their pipeline use). Add `constitution`, `specify`, `clarify`, `plan`, `tasks` to `src/tui/labels.ts` PHASE_LABELS.

- [ ] **Step 4: `job.ts`** — the "approved" branch passes `up.tasksPath` to the project-manager (PM reads tasks.md, not plan.md):
```ts
const board = await runProjectManager(pmOpts(deps, workdir, up.tasksPath));
```
and change `pmOpts`'s message to "Read the "<tasksPath>" task list and turn it into board tasks (id, title, deps)."

- [ ] **Step 5: Run → PASS; `npm run typecheck`; full suite.**

- [ ] **Step 6: Commit**
```bash
git commit -am "feat: upstream pipeline uses spec-kit phases (constitution→specify→clarify→plan→tasks)"
```

---

### Task 8: spec-kit slash commands

**Files:**
- Modify: `src/tui/commands.ts`, `src/tui/components.tsx` (runSlash), `src/tui/controller.ts` (a way to submit a phase command), `src/engine/job.ts`/`upstream.ts` (accept an explicit-phase entry — optional for MVP)
- Test: `test/tui/commands.test.ts`

**Scope for MVP:** Add the five commands to the palette registry so they're discoverable + type-completable. Wire `/constitution`, `/specify`, `/clarify`, `/plan`, `/tasks` to submit a normal task whose text triggers the corresponding phase via the pipeline's manual entry (a follow-up task can deepen per-phase re-runs). For this task, the minimum is: the commands appear in the palette and, when run, submit a recognizable directive (e.g. `submitTask("/clarify")`) that `job.ts` routes to the single phase on the current feature.

- [ ] **Step 1: Add to `COMMANDS` in `src/tui/commands.ts`:**
```ts
{ name: "/constitution", desc: "Create or update the project constitution" },
{ name: "/specify", desc: "Write the spec for the current feature" },
{ name: "/clarify", desc: "Clarify the spec via Q&A" },
{ name: "/plan", desc: "Write the implementation plan" },
{ name: "/tasks", desc: "Break the plan into tasks" },
```

- [ ] **Step 2: Test** — assert `matchCommands("/cl")` returns `/clarify`; palette lists all; `helpText()` includes them. (Extend `test/tui/commands.test.ts`.)

- [ ] **Step 3: Wire `runSlash`** in `components.tsx` — for these five, `controller.submitTask(c.name)`; `job.ts` detects a leading-slash directive and runs the single phase against the current feature (or tells the user to start a feature first). Keep the routing minimal; a dedicated single-phase runner can be added later.

- [ ] **Step 4: Run → PASS; typecheck; full suite.**

- [ ] **Step 5: Commit**
```bash
git commit -am "feat: spec-kit slash commands (/constitution //specify //clarify //plan //tasks)"
```

---

## Self-Review

- **Spec coverage:** template fetch+cache (T2), layout/scaffolding (T3), constitution/specify/plan/tasks phases (T4), clarify Q&A (T5), config pin (T1), deps wiring (T6), pipeline rewire + review loop preserved + tasks.md→board (T7), hybrid slash commands (T8). Constitution auto-on-missing + `/constitution` covered. Artifact layout covered. ✔
- **Type consistency:** `PhaseDeps` shared across phases + clarify; `FeaturePaths` shared; `UpstreamResult` gains `tasksPath`; `JobDeps.specKit` threaded. ✔
- **Known follow-ups (out of MVP scope, flagged):** per-phase single-run entry from slash commands is minimal in T8 (deepen later); spec-kit `/analyze` not integrated; the `currentAskUser` module-level holder in phases.ts is a simplification the reviewer may replace with explicit threading.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-22-horse-code-spec-kit-integration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints.

**Which approach?**
