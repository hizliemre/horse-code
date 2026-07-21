import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
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
  reg.register(shellTool);
  reg.register(createWebFetchTool());
  return reg;
}
