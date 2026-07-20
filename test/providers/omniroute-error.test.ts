import { describe, it, expect } from "vitest";
import { readErrorMessage } from "../../src/providers/omniroute.js";

describe("readErrorMessage", () => {
  it("401 düz-string error biçimini okur", async () => {
    const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    expect(await readErrorMessage(res)).toBe("Unauthorized");
  });

  it("obje error.message biçimini okur", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limit", type: "rate_limit" } }), {
      status: 429,
    });
    expect(await readErrorMessage(res)).toBe("rate limit");
  });

  it("JSON olmayan gövdede status'a düşer", async () => {
    const res = new Response("upstream boom", { status: 502 });
    expect(await readErrorMessage(res)).toBe("omniroute 502");
  });
});
