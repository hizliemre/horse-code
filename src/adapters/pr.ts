import { spawn } from "node:child_process";
import type { PRAdapter } from "../worktree/manager.js";

export type CmdRunner = (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Komutu child_process ile çalıştırır; asla throw etmez (GitRunner gibi). */
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

/** GitHub: gh pr create / gh pr comment. Stateful (PR number'ı saklar). */
export function ghAdapter(run: CmdRunner, cwd: string): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("gh", ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body], cwd);
      if (r.code !== 0) throw new Error(`gh pr create başarısız (${r.code}): ${r.stderr.trim()}`);
      const url = r.stdout.trim();
      prNumber = parsePRNumber(url);
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (prNumber === undefined || comments.length === 0) return;
      const r = await run("gh", ["pr", "comment", String(prNumber), "--body", joinComments(comments)], cwd);
      if (r.code !== 0) throw new Error(`gh pr comment başarısız (${r.code}): ${r.stderr.trim()}`);
    },
  };
}

/** Azure: az repos pr create (JSON). Yorumlar best-effort log (thread REST ileride). */
export function azAdapter(run: CmdRunner, cwd: string, log: (s: string) => void): RevisionPRAdapter {
  let prNumber: number | undefined;
  return {
    async createPR(input) {
      const r = await run("az", ["repos", "pr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "-o", "json"], cwd);
      if (r.code !== 0) throw new Error(`az repos pr create başarısız (${r.code}): ${r.stderr.trim()}`);
      let url = "";
      try {
        const j = JSON.parse(r.stdout) as { pullRequestId?: number; url?: string };
        prNumber = typeof j.pullRequestId === "number" ? j.pullRequestId : undefined;
        url = j.url ?? `(azure PR #${prNumber ?? "?"})`;
      } catch { url = r.stdout.trim() || "(azure PR)"; }
      return { url, number: prNumber };
    },
    async postComments(comments) {
      if (comments.length === 0) return;
      log(`Azure PR #${prNumber ?? "?"} yorumları (thread API ileride):\n${joinComments(comments)}`);
    },
  };
}

export function detectPlatform(remoteUrl: string): "github" | "azure" | "unknown" {
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("dev.azure.com") || remoteUrl.includes("visualstudio.com")) return "azure";
  return "unknown";
}

/** Platforma göre adapter; unknown → log-stub (PR açılmaz). */
export function makePRAdapter(opts: { platform: "github" | "azure" | "unknown"; run: CmdRunner; cwd: string; log: (s: string) => void }): RevisionPRAdapter {
  if (opts.platform === "github") return ghAdapter(opts.run, opts.cwd);
  if (opts.platform === "azure") return azAdapter(opts.run, opts.cwd, opts.log);
  return {
    async createPR(input) {
      opts.log(`PR (yerel — remote/platform yok): ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: `(yerel: ${input.branch})` };
    },
    async postComments(comments) {
      if (comments.length) opts.log(`PR yorumları: ${comments.join("; ")}`);
    },
  };
}
