import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { azAdapter, reviewThreadBody, isMachineTitle, type CmdRunner } from "../../src/adapters/pr.js";

const CREATED = JSON.stringify({
  pullRequestId: 765,
  url: "https://dev.azure.com/org/proj/_apis/git/repositories/8b30a883/pullRequests/765",
  repository: { id: "8b30a883-7772-4844-8c0a-49717becf33b", project: { name: "mirket" } },
});

/** Records every invocation, and reads back any `--in-file` before the adapter deletes it. */
function recorder(): { calls: { args: string[]; body?: string }[]; run: CmdRunner } {
  const calls: { args: string[]; body?: string }[] = [];
  const run: CmdRunner = async (_cmd, args) => {
    const i = args.indexOf("--in-file");
    const body = i >= 0 ? await readFile(args[i + 1], "utf8") : undefined;
    calls.push({ args, ...(body !== undefined ? { body } : {}) });
    return { stdout: args.includes("create") ? CREATED : "{}", stderr: "", code: 0 };
  };
  return { calls, run };
}

/**
 * A review nobody can see is not a review.
 *
 * The Azure adapter's `postComments` was a `log()` call carrying the note "thread REST later". Measured on
 * PR #765: the principal review found seven committed build artifacts (including files under `node_modules/`),
 * unexplained dependency churn, and an infinite-loop hazard — all five findings recorded on the board, and
 * `pullRequestThreads` on the pull request returned an empty list.
 */
describe("azure review comments reach the pull request", () => {
  it("opens a thread with the findings in it", async () => {
    const { calls, run } = recorder();
    const az = azAdapter(run, "/repo", () => {});
    await az.createPR({ branch: "hc/j/base", base: "development", title: "t", body: "b" });
    await az.postComments(["artifacts committed", "dependency churn"]);

    const thread = calls.find((c) => c.args.includes("pullRequestThreads"));
    expect(thread, "no thread was opened").toBeDefined();
    expect(thread!.args).toContain("POST");
    expect(thread!.args).toContain("project=mirket");
    expect(thread!.args).toContain("repositoryId=8b30a883-7772-4844-8c0a-49717becf33b");
    expect(thread!.args).toContain("pullRequestId=765");

    const sent = JSON.parse(thread!.body!) as { comments: { content: string }[]; status: string };
    expect(sent.comments[0].content).toContain("artifacts committed");
    expect(sent.comments[0].content).toContain("dependency churn");
    expect(sent.status).toBe("active");
  });

  it("says how many changes the round asked for, so a reader knows it is a review", () => {
    const body = reviewThreadBody(["a", "b", "c"]);
    expect(body).toMatch(/3 change/);
    expect(body).toContain("1. a");
    expect(body).toContain("3. c");
  });

  it("posts nothing when there is nothing to say", async () => {
    const { calls, run } = recorder();
    const az = azAdapter(run, "/repo", () => {});
    await az.createPR({ branch: "b", base: "development", title: "t", body: "b" });
    await az.postComments([]);
    expect(calls.some((c) => c.args.includes("pullRequestThreads"))).toBe(false);
  });

  /** Without the identifiers there is nowhere to post — and the findings must still be readable. */
  it("falls back to the log rather than dropping the findings", async () => {
    const logged: string[] = [];
    const run: CmdRunner = async () => ({ stdout: "not json", stderr: "", code: 0 });
    const az = azAdapter(run, "/repo", (s) => logged.push(s));
    await az.createPR({ branch: "b", base: "development", title: "t", body: "b" });
    await az.postComments(["the finding"]);
    expect(logged.join("\n")).toContain("the finding");
  });

  it("reports a rejected thread instead of reporting success", async () => {
    const run: CmdRunner = async (_c, args) =>
      args.includes("pullRequestThreads")
        ? { stdout: "", stderr: "TF401019", code: 1 }
        : { stdout: CREATED, stderr: "", code: 0 };
    const az = azAdapter(run, "/repo", () => {});
    await az.createPR({ branch: "b", base: "development", title: "t", body: "b" });
    await expect(az.postComments(["x"])).rejects.toThrow(/TF401019/);
  });
});

const OPEN_LIST = JSON.stringify([{
  pullRequestId: 765,
  url: "https://dev.azure.com/org/proj/_apis/git/repositories/8b30a883/pullRequests/765",
  repository: { id: "8b30a883-7772-4844-8c0a-49717becf33b", project: { name: "mirket" } },
}]);

/**
 * A resumed run opens its pull request again, because the board does not record that it did.
 *
 * On PR #765 that meant `az repos pr create` for a source/target pair that already had an active pull
 * request — refused by the platform, and the job would have died before reaching the review it was resumed
 * FOR. Adopting the open one is also the only way `postComments` learns where to post.
 */
describe("a pull request that is already open", () => {
  const refusing: CmdRunner = async (_cmd, args) => {
    if (args.includes("create")) return { stdout: "", stderr: "TF401179: An active pull request already exists", code: 1 };
    if (args.includes("list")) return { stdout: OPEN_LIST, stderr: "", code: 0 };
    return { stdout: "{}", stderr: "", code: 0 };
  };

  it("is adopted rather than failing the run", async () => {
    const az = azAdapter(refusing, "/repo", () => {});
    const res = await az.createPR({ branch: "hc/j/base", base: "development", title: "t", body: "b" });
    expect(res.number).toBe(765);
  });

  it("gives the review somewhere to post", async () => {
    const seen: string[][] = [];
    const run: CmdRunner = async (cmd, args) => { seen.push(args); return refusing(cmd, args, "/repo"); };
    const az = azAdapter(run, "/repo", () => {});
    await az.createPR({ branch: "hc/j/base", base: "development", title: "t", body: "b" });
    await az.postComments(["the finding"]);
    expect(seen.some((a) => a.includes("pullRequestThreads") && a.includes("pullRequestId=765"))).toBe(true);
  });

  /** A create that failed for a real reason must still be reported as a failure. */
  it("still throws when there is no open pull request to adopt", async () => {
    const run: CmdRunner = async (_cmd, args) =>
      args.includes("create")
        ? { stdout: "", stderr: "TF401027: no permission", code: 1 }
        : { stdout: "[]", stderr: "", code: 0 };
    const az = azAdapter(run, "/repo", () => {});
    await expect(az.createPR({ branch: "b", base: "development", title: "t", body: "b" }))
      .rejects.toThrow(/TF401027/);
  });
});

/** An adopted pull request keeps the bad title it was opened with, unless the resume replaces it. */
describe("the title of an adopted pull request", () => {
  const listing = (title: string): CmdRunner => async (_cmd, args) => {
    if (args.includes("create")) return { stdout: "", stderr: "already exists", code: 1 };
    if (args.includes("list")) return { stdout: JSON.stringify([{ ...JSON.parse(OPEN_LIST)[0], title }]), stderr: "", code: 0 };
    return { stdout: "{}", stderr: "", code: 0 };
  };

  it("is refreshed when it is still the slug the machine opened with", async () => {
    const seen: string[][] = [];
    const run: CmdRunner = async (c, a, d) => { seen.push(a); return listing("hc: product-description-rendering-bug")(c, a, d); };
    await azAdapter(run, "/repo", () => {}).createPR({
      branch: "hc/j/base", base: "development", title: "fix(products): açıklama güvenli HTML", body: "Kısa." });
    const update = seen.find((a) => a.includes("update"));
    expect(update, "the machine title was left in place").toBeDefined();
    expect(update).toContain("fix(products): açıklama güvenli HTML");
  });

  it("is left alone when a person has written one", async () => {
    const seen: string[][] = [];
    const run: CmdRunner = async (c, a, d) => { seen.push(a); return listing("fix(products): elle yazılmış başlık")(c, a, d); };
    await azAdapter(run, "/repo", () => {}).createPR({ branch: "hc/j/base", base: "development", title: "t", body: "b" });
    expect(seen.some((a) => a.includes("update"))).toBe(false);
  });
});

describe("which titles count as the machine's own", () => {
  it("recognises what a run used to open with", () => {
    expect(isMachineTitle("hc: product-description-rendering-bug")).toBe(true);
    expect(isMachineTitle("  hc: some-job ")).toBe(true);
  });
  it("does not claim a conventional title, however it was produced", () => {
    expect(isMachineTitle("fix(products): açıklama artık güvenli HTML")).toBe(false);
    expect(isMachineTitle("hcode: something")).toBe(false);
  });
});
