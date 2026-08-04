import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { gitTool } from "./git.js";
import { shellTool } from "./shell.js";
import { createWebFetchTool } from "./web.js";

export { ToolRegistry } from "./registry.js";

/** Returns a ToolRegistry with the MVP's 7 tools registered. */
export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(readFileTool);
  reg.register(writeFileTool);
  reg.register(editFileTool);
  reg.register(grepTool);
  reg.register(globTool);
  /**
   * Read-only git, for every agent — because the alternative was shell, and that is what happened.
   *
   * Measured over one 577-minute run: 298 of 1,216 shell commands were git, and 320 of the 356 git verbs
   * inside them were read-only — `status` 84 times, `diff` 81, `log` 64, `show` 57. Of the 62 agents that
   * used shell, 58 never called the `git` tool once. They were not choosing shell over it; the default
   * registry did not carry it, so an implementer or a reviser had nothing else to reach for.
   *
   * It refuses everything that changes anything (see src/tools/git.ts), so there is no reason to withhold it.
   */
  reg.register(gitTool);
  reg.register(shellTool);
  reg.register(createWebFetchTool());
  return reg;
}
