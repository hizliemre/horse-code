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

export type ReviewOutcome = "changes" | "approved";

export interface RevisionPRAdapter extends PRAdapter {
  postComments(comments: string[], outcome?: ReviewOutcome): Promise<void>;
  /**
   * Resolves the threads horse-code itself opened — called when the review APPROVES.
   *
   * Every thread it opened stayed `Active` forever. Measured on PR #765: two outstanding threads while all
   * seven findings of the first were demonstrably fixed on the branch — no scratch files tracked, lockfile
   * back in sync, the regression tests written — and the review had since approved the result. Approving
   * while your own objections still read as open leaves the reader to work out which ones still stand.
   *
   * Scoped to threads carrying horse-code's own marker: a person's comment is theirs to close.
   */
  resolveOwnThreads(): Promise<void>;
}

export function parsePRNumber(url: string): number | undefined {
  const m = url.match(/\/(?:pull|pullrequest)\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function joinComments(comments: string[]): string {
  return comments.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/**
 * A pull request that is ALREADY open for this branch is the one to use, not a reason to fail.
 *
 * A resumed run pushes and opens its pull request again, because the board does not record that it did.
 * Measured on PR #765: a resume would call `az repos pr create` for a source/target pair that already has an
 * active pull request, the platform would refuse it, and the job would die before reaching the review it was
 * resumed FOR. Adopting the open one also gives `postComments` the identity it needs — without it the review
 * has nowhere to post even when everything else works.
 */
export function ghAdapter(run: CmdRunner, cwd: string): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("gh", ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body], cwd);
      if (r.code !== 0) {
        const open = await run("gh", ["pr", "list", "--head", input.branch, "--base", input.base, "--state", "open", "--json", "number,url"], cwd);
        try {
          const [first] = JSON.parse(open.stdout) as { number?: number; url?: string }[];
          if (first?.number !== undefined) { prNumber = first.number; return { url: first.url ?? "", number: prNumber }; }
        } catch { /* no usable list → report the original failure */ }
        throw new Error(`gh pr create failed (${r.code}): ${r.stderr.trim()}`);
      }
      const url = r.stdout.trim();
      prNumber = parsePRNumber(url);
      return { url, number: prNumber };
    },
    async postComments(comments, outcome) {
      if (prNumber === undefined || (comments.length === 0 && outcome !== "approved")) return;
      const r = await run("gh", ["pr", "comment", String(prNumber), "--body", reviewThreadBody(comments, outcome)], cwd);
      if (r.code !== 0) throw new Error(`gh pr comment failed (${r.code}): ${r.stderr.trim()}`);
    },
    async resolveOwnThreads() { /* github issue comments carry no resolved state */ },
  };
}

/**
 * Whether an adopted pull request still carries a title nobody has touched.
 *
 * `hc: <job-slug>` is what a run used to open with, so refreshing it is restoring what the summary should
 * have written in the first place. Anything else is a title a person chose, and a resume must not overwrite it.
 */
export function isMachineTitle(title: string): boolean {
  return /^hc:\s/.test(title.trim());
}

/** Azure's word for what its UI shows as "Resolved". */
export const RESOLVED_STATUS = "fixed";

/** How horse-code recognises its own comments among everyone else's. */
export const REVIEW_MARKER = "**horse-code review**";

interface ThreadList { value?: { id?: number; status?: string; comments?: { content?: string }[] }[] }

/** The still-open threads horse-code opened. A person's comment is theirs to close, whatever it says. */
export function ownOpenThreads(list: ThreadList): string[] {
  return (list.value ?? [])
    .filter((t) => (t.status ?? "").toLowerCase() === "active")
    .filter((t) => (t.comments ?? []).some((c) => (c.content ?? "").includes(REVIEW_MARKER)))
    .map((t) => String(t.id ?? ""))
    .filter(Boolean);
}

interface AzurePR {
  title?: string;
  pullRequestId?: number;
  url?: string;
  repository?: { id?: string; project?: { name?: string } };
}

/**
 * What the review says about itself when it opens a thread.
 *
 * An approval used to say nothing at all: `postComments` is only called when changes are requested, so a
 * review that read the whole merged diff and passed it left the pull request exactly as silent as one that
 * never ran. Measured live — the review approved, and the only threads on PR #765 were from the rounds that
 * had asked for changes. "No comment" cannot be the record of both outcomes.
 */
export function reviewThreadBody(comments: string[], outcome: ReviewOutcome = "changes"): string {
  if (outcome === "approved") {
    return `${REVIEW_MARKER} — approved. The merged diff was reviewed and no changes are requested.`
      + (comments.length ? `\n\n${joinComments(comments)}` : "");
  }
  return `${REVIEW_MARKER} — ${comments.length} change(s) requested:\n\n${joinComments(comments)}`;
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
  let threadSeq = 0;
  let prNumber: number | undefined;
  let project: string | undefined;
  let repositoryId: string | undefined;
  return {
    async createPR(input) {
      const adopt = (j: AzurePR | undefined): string | undefined => {
        if (typeof j?.pullRequestId !== "number") return undefined;
        prNumber = j.pullRequestId;
        repositoryId = j.repository?.id;
        project = j.repository?.project?.name;
        return j.url ?? `(azure PR #${prNumber})`;
      };
      const r = await run("az", ["repos", "pr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "-o", "json"], cwd);
      if (r.code !== 0) {
        const open = await run("az", ["repos", "pr", "list", "--source-branch", input.branch, "--target-branch", input.base, "--status", "active", "-o", "json"], cwd);
        try {
          const existing = (JSON.parse(open.stdout) as AzurePR[])[0];
          const url = adopt(existing);
          if (url !== undefined) {
            if (isMachineTitle(existing?.title ?? "")) {
              await run("az", ["repos", "pr", "update", "--id", String(prNumber), "--title", input.title, "--description", input.body, "-o", "none"], cwd);
            }
            return { url, number: prNumber };
          }
        } catch { /* no usable list → report the original failure */ }
        throw new Error(`az repos pr create failed (${r.code}): ${r.stderr.trim()}`);
      }
      let url = "";
      try { url = adopt(JSON.parse(r.stdout) as AzurePR) ?? r.stdout.trim(); }
      catch { url = r.stdout.trim() || "(azure PR)"; }
      return { url, number: prNumber };
    },
    async postComments(comments, outcome) {
      if (comments.length === 0 && outcome !== "approved") return;
      if (prNumber === undefined || !project || !repositoryId) {
        // Nothing to post against — say so rather than pretending, and keep the findings readable.
        log(`Azure PR comments could not be addressed (no pull request identity):\n${joinComments(comments)}`);
        return;
      }
      const file = join(tmpdir(), `hc-pr-thread-${prNumber}-${process.pid}-${threadSeq++}.json`);
      const body = { comments: [{ parentCommentId: 0, content: reviewThreadBody(comments, outcome), commentType: "text" }],
        status: outcome === "approved" ? "closed" : "active" };
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
    async resolveOwnThreads() {
      if (prNumber === undefined || !project || !repositoryId) return;
      const route = ["--route-parameters", `project=${project}`, `repositoryId=${repositoryId}`, `pullRequestId=${prNumber}`];
      const list = await run("az", ["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads",
        ...route, "--api-version", "7.1", "-o", "json"], cwd);
      if (list.code !== 0) { log(`Could not read the pull request threads to resolve them: ${list.stderr.trim()}`); return; }
      let ids: string[] = [];
      try { ids = ownOpenThreads(JSON.parse(list.stdout) as ThreadList); }
      catch { log("The pull request thread list could not be read."); return; }
      for (const id of ids) {
        const file = join(tmpdir(), `hc-pr-resolve-${prNumber}-${process.pid}-${threadSeq++}.json`);
        await writeFile(file, JSON.stringify({ status: RESOLVED_STATUS }), "utf8");
        try {
          const r = await run("az", ["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads",
            ...route, `threadId=${id}`,
            "--http-method", "PATCH", "--in-file", file, "--api-version", "7.1", "-o", "none"], cwd);
          // Best-effort: an unresolved thread is untidy, never a reason to fail a reviewed pull request.
          if (r.code !== 0) log(`Could not resolve pull request thread ${id}: ${r.stderr.trim()}`);
        } finally {
          await rm(file, { force: true });
        }
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
    async postComments(comments, outcome) {
      if (comments.length || outcome === "approved") opts.log(`PR review: ${reviewThreadBody(comments, outcome)}`);
    },
    async resolveOwnThreads() { /* nothing was opened */ },
  };
}
