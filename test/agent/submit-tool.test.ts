import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSubmitTool } from "../../src/agent/structured.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });
const schema = z.object({ decision: z.enum(["pass", "fail"]) });

describe("buildSubmitTool", () => {
  it("captures valid args (isError:false)", async () => {
    const h = buildSubmitTool(schema);
    const res = await h.tool.run({ decision: "pass" }, ctx());
    expect(res.isError).toBe(false);
    expect(h.result()).toEqual({ value: { decision: "pass" } });
  });

  it("does not capture invalid args (isError:true, box empty)", async () => {
    const h = buildSubmitTool(schema);
    const res = await h.tool.run({ decision: "bogus" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("invalid");
    expect(h.result()).toBeUndefined();
  });

  it("tool metadata is correct (name/safe/parameters)", () => {
    const h = buildSubmitTool(schema);
    expect(h.tool.name).toBe("submit");
    expect(h.tool.permissionLevel).toBe("safe");
    expect(h.tool.parameters).toBe(schema);
  });
});
