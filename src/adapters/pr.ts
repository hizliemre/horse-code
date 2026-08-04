import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PRAdapter } from "../worktree/manager.js";

export type CmdRunner = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Runs the command via child_process; never throws (like GitRunner). */
export const defaultCmdRunner: CmdRunner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try { child = spawn(cmd, args, { cwd }); }
    catch (e) { resolve({ stdout, stderr: e instanceof Error ? e.message : String(e), code: -1 }); return; }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });

export interface RevisionPRAdapter extends PRAdapter {
  postComments(comments: string[]): Promise<void>;
}

export function parsePRNumber(url: string): number | undefined {
  const m = url.match(/\/(?:pull|pullrequest)\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function joinComments(comments: string[]): string {
  return comments.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/** GitHub: gh pr create / gh pr comment. Stateful (stores the PR number). */
export function ghAdapter(run: CmdRunner, cwd: string): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("gh", ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body], cwd);
      if (r.code !== 0) throw new Error(`gh pr create failed (${r.code}): ${r.stderr.trim()}`);
      const url = r.stdout.trim();
      prNumber = parsePRNumber(url);
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (prNumber === undefined || comments.length === 0) return;
      const r = await run("gh", ["pr", "comment", String(prNumber), "--body", joinComments(comments)], cwd);
      if (r.code !== 0) throw new Error(`gh pr comment failed (${r.code}): ${r.stderr.trim()}`);
    },
  };
}

/** What the review says about itself when it opens a thread, so the round is readable as a round. */
export function reviewThreadBody(comments: string[]): string {
  return `**horse-code review** — ${comments.length} change(s) requested:\n\n${joinComments(comments)}`;
}

/**
 * Azure: `az repos pr create`, and review comments as a real thread on the pull request.
 *
 * The thread used to be a `log()` call with the note "thread REST later" — so a run could review its own
 * merged diff, find seven committed build artifacts and an infinite-loop hazard, and leave the pull request
 * with zero comments on it. Measured on PR #765: five substantial findings recorded on the board, and
 * `pullRequestThreads` returned an empty list. Reviewing where nobody can see it is not reviewing.
 *
 * `az` has no `pr comment` verb, so this goes through `az devops invoke`, which only accepts a request body
 * as a file — hence the temp file. The identifiers come from the create response, which is the only place
 * they are known without asking the remote again.
 */
export function azAdapter(run: CmdRunner, cwd: string, log: (s: string) => void): RevisionPRAdapter {
  let prNumber: number | undefined;
  let project: string | undefined;
  let repositoryId: string | undefined;
  return {
    async createPR(input) {
      const r = await run("az", ["repos", "pr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "-o", "json"], cwd);
      if (r.code !== 0) throw new Error(`az repos pr create failed (${r.code}): ${r.stderr.trim()}`);
      let url = "";
      try {
        const j = JSON.parse(r.stdout) as {
          pullRequestId?: number; url?: string;
          repository?: { id?: string; project?: { name?: string } };
        };
        prNumber = typeof j.pullRequestId === "number" ? j.pullRequestId : undefined;
        repositoryId = j.repository?.id;
        project = j.repository?.project?.name;
        url = j.url ?? `(azure PR #${prNumber ?? "?"})`;
      } catch { url = r.stdout.trim() || "(azure PR)"; }
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (comments.length === 0) return;
      if (prNumber === undefined || !project || !repositoryId) {
        // Nothing to post against — say so rather than pretending, and keep the findings readable.
        log(`Azure PR comments could not be addressed (no pull request identity):\n${joinComments(comments)}`);
        return;
      }
      const file = join(tmpdir(), `hc-pr-thread-${prNumber}-${process.pid}.json`);
      const body = { comments: [{ parentCommentId: 0, content: reviewThreadBody(comments), commentType: "text" }], status: "active" };
      await writeFile(file, JSON.stringify(body), "utf8");
      try {
        const r = await run("az", ["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads",
          "--route-parameters", `project=${project}`, `repositoryId=${repositoryId}`, `pullRequestId=${prNumber}`,
          "--http-method", "POST", "--in-file", file, "--api-version", "7.1", "-o", "json"], cwd);
        if (r.code !== 0) throw new Error(`az devops invoke pullRequestThreads failed (${r.code}): ${r.stderr.trim()}`);
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}

export function detectPlatform(remoteUrl: string): "github" | "azure" | "unknown" {
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("dev.azure.com") || remoteUrl.includes("visualstudio.com")) return "azure";
  return "unknown";
}

/** Adapter by platform; unknown → log-stub (no PR is opened). */
export function makePRAdapter(opts: { platform: "github" | "azure" | "unknown"; run: CmdRunner; cwd: string; log: (s: string) => void }): RevisionPRAdapter {
  if (opts.platform === "github") return ghAdapter(opts.run, opts.cwd);
  if (opts.platform === "azure") return azAdapter(opts.run, opts.cwd, opts.log);
  return {
    async createPR(input) {
      opts.log(`PR (local — no remote/platform): ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: `(local: ${input.branch})` };
    },
    async postComments(comments) {
      if (comments.length) opts.log(`PR comments: ${comments.join("; ")}`);
    },
  };
}
