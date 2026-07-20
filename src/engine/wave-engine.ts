import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree, MergeResult, PRAdapter } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import { runWaveTask } from "./wave-task.js";
import { runConflictCouncil } from "./conflict.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runTeamLead } from "./team-lead.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildSkillTool } from "../skills/apply.js";

export interface WaveEngineDeps extends EscalationDeps {
  manager: WorktreeManager;
  prAdapter: PRAdapter;
}

export interface WaveOutcome {
  merged: string[];
  failed: string[];
  skipped: string[];
}

/** Söz-zinciri mutex: her çağrı öncekinin ardından koşar; sonucu/hatasını aynen döndürür. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn());
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * Tek dalga: blocked bağımlılığa sahip task'ları atla; kalanları paylaşımlı mutex +
 * resolveConflict (merge kilidi içinde runConflictCouncil) ile paralel koş; sonuçları sınıfla.
 */
export async function runWave(
  deps: WaveEngineDeps,
  session: WorktreeSession,
  board: Board,
  taskIds: string[],
  blocked: Set<string>,
): Promise<WaveOutcome> {
  const skipped = taskIds.filter((t) => board.get(t)!.deps.some((d) => blocked.has(d)));
  const runnable = taskIds.filter((t) => !skipped.includes(t));
  for (const t of skipped) {
    board.appendStage(t, { role: "team-lead", action: "skipped", note: "bağımlılık başarısız" });
  }

  const ser = createMutex();
  const results = await Promise.all(
    runnable.map(async (t) => {
      const resolveConflict = async (tw: TaskWorktree, files: string[]): Promise<MergeResult> => {
        try {
          const r = await runConflictCouncil(deps, session, board, t, tw);
          return r.status === "resolved" ? { status: "merged" } : { status: "conflict", files };
        } catch (e) {
          // iptal → fırlat (base mid-merge kalabilir; temizlik session teardown'a — G/H).
          // Kuyruğa girmiş bir sibling merge dirty ağaca çarpsa git reddeder (merged dönmez) → false PR yok.
          if (deps.signal.aborted) throw e;
          try { await deps.manager.abortMerge(session); } catch { /* zaten temiz olabilir */ }
          return { status: "conflict", files };
        }
      };
      const res = await runWaveTask({ ...deps, serialize: ser, resolveConflict }, session, board, t);
      return { t, status: res.status };
    }),
  );

  return {
    merged: results.filter((r) => r.status === "merged").map((r) => r.t),
    failed: results.filter((r) => r.status !== "merged").map((r) => r.t),
    skipped,
  };
}

export type WaveEngineResult =
  | { status: "completed"; session: WorktreeSession; pr: { url: string }; waves: string[][] }
  | { status: "partial"; session: WorktreeSession; failed: string[]; skipped: string[]; waves: string[][] };

function teamLeadOpts(deps: WaveEngineDeps, session: WorktreeSession): RoleAgentOptions {
  const tl = deps.roleRegistry.resolve("team-lead");
  const tools = new ToolRegistry();
  tools.register(buildSkillTool(deps.skillRegistry));
  return {
    provider: deps.provider, model: tl.model, systemPrompt: tl.systemPrompt,
    tools, messages: [], permission: deps.permission, approve: deps.approve,
    cwd: session.baseWorktree, signal: deps.signal,
  };
}

/**
 * Deterministik dış döngü: openSession → team-lead dalgaları → her dalga paralel runWave
 * (başarısızın bağımlıları atlanır) → tüm task'lar başarılıysa push+openPR, değilse {partial}.
 */
export async function runWaveEngine(
  deps: WaveEngineDeps,
  board: Board,
  opts: { fromBranch: string; jobName: string; prTitle?: string },
): Promise<WaveEngineResult> {
  const session = await deps.manager.openSession(opts.fromBranch, opts.jobName);
  const waves = await runTeamLead(teamLeadOpts(deps, session), board);

  const blocked = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wave of waves) {
    const o = await runWave(deps, session, board, wave, blocked);
    for (const t of o.failed) { blocked.add(t); failed.push(t); }
    for (const t of o.skipped) { blocked.add(t); skipped.push(t); }
    // başarılı merge'ler base'e commit'lendi → sonraki dalga güncellenmiş base'den türer (D otomatik)
  }

  if (failed.length === 0 && skipped.length === 0) {
    await deps.manager.push(session);
    const body = "Tamamlanan task'lar:\n" + board.list().map((c) => `- ${c.title}`).join("\n");
    const pr = await deps.manager.openPR(session, deps.prAdapter, {
      base: opts.fromBranch,
      title: opts.prTitle ?? `hc: ${opts.jobName}`,
      body,
    });
    return { status: "completed", session, pr, waves };
  }
  return { status: "partial", session, failed, skipped, waves };
}
