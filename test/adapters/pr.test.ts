import { describe, it, expect } from "vitest";
import { parsePRNumber, ghAdapter, azAdapter, detectPlatform, makePRAdapter, type CmdRunner } from "../../src/adapters/pr.js";

function fakeRunner(out: { stdout?: string; code?: number } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = (async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { stdout: out.stdout ?? "", stderr: "", code: out.code ?? 0 }; }) as unknown as CmdRunner & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn as unknown as CmdRunner & { calls: { cmd: string; args: string[] }[] };
}

describe("parsePRNumber", () => {
  it("github/azure url → number; geçersiz → undefined", () => {
    expect(parsePRNumber("https://github.com/o/r/pull/7")).toBe(7);
    expect(parsePRNumber("https://dev.azure.com/o/p/_git/r/pullrequest/45")).toBe(45);
    expect(parsePRNumber("x")).toBeUndefined();
  });
});

describe("ghAdapter", () => {
  it("createPR gh komutunu kurar, url→number; postComments gh comment kurar", async () => {
    const run = fakeRunner({ stdout: "https://github.com/o/r/pull/7\n" });
    const a = ghAdapter(run, "/repo");
    const pr = await a.createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(pr.number).toBe(7);
    expect(run.calls[0]).toEqual({ cmd: "gh", args: ["pr", "create", "--base", "main", "--head", "hc/j/base", "--title", "T", "--body", "B"] });
    await a.postComments(["ilk", "ikinci"]);
    expect(run.calls[1].cmd).toBe("gh");
    expect(run.calls[1].args.slice(0, 3)).toEqual(["pr", "comment", "7"]);
    expect(run.calls[1].args[4]).toContain("ilk");
  });
  it("PR açılmadan postComments no-op", async () => {
    const run = fakeRunner();
    await ghAdapter(run, "/repo").postComments(["x"]);
    expect(run.calls.length).toBe(0);
  });
  it("createPR başarısızsa fırlatır", async () => {
    const run = fakeRunner({ code: 1 });
    await expect(ghAdapter(run, "/repo").createPR({ branch: "b", base: "main", title: "T", body: "B" })).rejects.toThrow();
  });
});

describe("azAdapter", () => {
  it("createPR az komutunu kurar (JSON→number); postComments log'lar", async () => {
    const run = fakeRunner({ stdout: '{"pullRequestId":45,"url":"http://az/45"}' });
    const logs: string[] = [];
    const a = azAdapter(run, "/repo", (s) => logs.push(s));
    const pr = await a.createPR({ branch: "hc/j/base", base: "main", title: "T", body: "B" });
    expect(pr.number).toBe(45);
    expect(run.calls[0].cmd).toBe("az");
    expect(run.calls[0].args.slice(0, 3)).toEqual(["repos", "pr", "create"]);
    await a.postComments(["bulgu"]);
    expect(logs.some((l) => l.includes("bulgu"))).toBe(true);
  });
});

describe("detectPlatform", () => {
  it("github/azure/unknown", () => {
    expect(detectPlatform("git@github.com:o/r.git")).toBe("github");
    expect(detectPlatform("https://dev.azure.com/o/p/_git/r")).toBe("azure");
    expect(detectPlatform("https://gitlab.com/o/r.git")).toBe("unknown");
  });
});

describe("makePRAdapter", () => {
  it("github→gh, azure→az, unknown→log-stub", async () => {
    const ghRun = fakeRunner({ stdout: "https://github.com/o/r/pull/1" });
    const gh = makePRAdapter({ platform: "github", run: ghRun, cwd: "/r", log: () => {} });
    await gh.createPR({ branch: "b", base: "main", title: "T", body: "B" });
    expect(ghRun.calls[0].cmd).toBe("gh");

    const logs: string[] = [];
    const unk = makePRAdapter({ platform: "unknown", run: fakeRunner(), cwd: "/r", log: (s) => logs.push(s) });
    const pr = await unk.createPR({ branch: "b", base: "main", title: "T", body: "B" });
    expect(pr.url).toContain("bilinmeyen");
    expect(logs.length).toBeGreaterThan(0);
  });
});
