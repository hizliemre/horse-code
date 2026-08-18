import { z } from "zod";
import type { ChatRequest, Tool } from "../core/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /**
   * Registered and callable, but whose SCHEMA is withheld until something asks for it.
   *
   * A schema is paid for on every turn, whether or not the tool is ever used. Measured across twelve runs:
   * 49 MCP tool schemas came to 86,620 characters (~21,655 tokens), 242 calls carried them, and that is
   * ~5.2M of the 21.7M input tokens billed — 24% of everything — for FIVE tool calls, of two distinct tools.
   * The catalogue that names them costs 900 characters (see MAX_TOOL_NOTE_CHARS); it is the schemas that are
   * expensive, and a schema nobody is about to use buys nothing.
   */
  private deferred = new Set<string>();
  /** Bumped by anything that changes what `schemas()` would return, so the derivation can be cached. */
  private version = 0;
  private cached?: { version: number; withdrawn: number; schemas: ChatRequest["tools"] };

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.deferred.delete(tool.name);
    this.version++;
  }

  /** Callable by name from the moment it is registered; sent to the model only once {@link surface}d. */
  registerDeferred(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.deferred.add(tool.name);
    this.version++;
  }

  /**
   * Hands over the schemas for these names, from the next turn onward.
   *
   * Returns the ones that were actually withheld, so a caller can say what it just made available and stay
   * quiet about what was already there.
   */
  surface(names: string[]): string[] {
    const opened = names.filter((n) => this.deferred.has(n));
    for (const n of opened) this.deferred.delete(n);
    if (opened.length) this.version++;
    return opened;
  }

  /** Everything still withheld — what a search tool searches. */
  deferredTools(): Tool[] {
    return [...this.deferred].map((n) => this.tools.get(n)).filter((t): t is Tool => t !== undefined);
  }

  /**
   * A withheld tool is still CALLABLE.
   *
   * A model that reads the catalogue and calls the name straight off is right, and refusing it to enforce a
   * search step would spend a turn teaching it a rule that exists for our benefit, not its.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Tool schemas to send to the LLM: zod parameters → JSON Schema (zod 4 native). Withheld ones are omitted.
   *
   * …and so is a tool that has withdrawn itself. `Tool.broken` was documented as being read "where tools are
   * OFFERED, so a broken one stops being handed to fresh agents" — and only `find_tool` ever read it, which
   * covers the deferred tools and not the ones already on the list.
   *
   * Measured on one run: `mcp__angular-cli__list_projects` answered its first caller with a reply that failed
   * its own declared output schema and withdrew itself. It was then offered to seventeen more agents, who
   * called it twenty-eight more times. Every one of those was answered instantly, without touching the
   * server — and still cost a whole model turn to learn what the run already knew.
   */
  schemas(): ChatRequest["tools"] {
    // A tool withdraws itself from inside its own closure, which does not touch `version` — so the cache is
    // keyed on how many are withdrawn as well. Counting a few dozen booleans is cheaper than rebuilding.
    const withdrawn = this.list().reduce((n, t) => n + (t.broken === undefined ? 0 : 1), 0);
    if (this.cached?.version === this.version && this.cached.withdrawn === withdrawn) return this.cached.schemas;
    const schemas = this.list()
      .filter((t) => !this.deferred.has(t.name) && t.broken === undefined)
      .map((t) => ({
        name: t.name,
        description: t.description,
        // MCP tools already carry a JSON Schema; everyone else derives it from their zod parameters.
        parameters: t.rawSchema ?? z.toJSONSchema(t.parameters, { target: "draft-7" }),
      }));
    this.cached = { version: this.version, withdrawn, schemas };
    return schemas;
  }
}
