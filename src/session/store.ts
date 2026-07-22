import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** One conversation message persisted for resume (tool-activity items are not persisted). */
export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

/** Lightweight listing entry (no message bodies) → shown by /sessions. */
export interface SessionSummary {
  id: string;
  title: string; // derived from the first user message
  updatedAt: number; // epoch ms of the last save
  count: number; // number of messages
}

export interface SessionData extends SessionSummary {
  messages: SessionMessage[];
}

export interface SessionStoreOpts {
  home: string; // e.g. os.homedir()
  cwd: string; // the project directory → sessions are scoped per project
  now?: () => number; // injectable clock (tests)
}

/** Per-project session persistence: ~/.horsecode/projects/<hash(cwd)>/sessions/<id>.json (one JSON per session). */
export class SessionStore {
  private activeId: string;
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: SessionStoreOpts) {
    this.now = opts.now ?? ((): number => Date.now());
    const hash = createHash("sha256").update(opts.cwd).digest("hex").slice(0, 16);
    this.dir = join(opts.home, ".horsecode", "projects", hash, "sessions");
    this.activeId = `s${this.now()}`;
  }

  /** The id this store currently writes to (a fresh one, or a resumed session's id after setActive). */
  get id(): string {
    return this.activeId;
  }

  /** Continue an existing session → subsequent saves overwrite that session's file instead of forking. */
  setActive(id: string): void {
    this.activeId = id;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Overwrite the active session with the current messages (no-op on an empty transcript). */
  async save(messages: SessionMessage[]): Promise<void> {
    if (messages.length === 0) return; // don't create an empty session file
    await mkdir(this.dir, { recursive: true });
    const data: SessionData = {
      id: this.activeId,
      title: titleOf(messages),
      updatedAt: this.now(),
      count: messages.length,
      messages,
    };
    await writeFile(this.file(this.activeId), JSON.stringify(data), "utf8");
  }

  /** All sessions for this project, newest first. Corrupt files are skipped. */
  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // no sessions dir yet
    }
    const out: SessionSummary[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const d = JSON.parse(await readFile(join(this.dir, n), "utf8")) as SessionData;
        out.push({ id: d.id, title: d.title, updatedAt: d.updatedAt, count: d.count });
      } catch {
        /* skip a corrupt/partial file */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Load a full session by id (undefined if missing/corrupt). */
  async load(id: string): Promise<SessionData | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as SessionData;
    } catch {
      return undefined;
    }
  }
}

/** First user message → a short one-line title. */
function titleOf(messages: SessionMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "(untitled)";
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}
