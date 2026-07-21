import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatRequest, Tool } from "../core/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool schemas to send to the LLM: zod parameters → JSON Schema. */
  schemas(): ChatRequest["tools"] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters, { target: "openApi3" }),
    }));
  }
}
