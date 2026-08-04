import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { azAdapter, reviewThreadBody, type CmdRunner } from "../../src/adapters/pr.js";

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
