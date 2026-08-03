import { z } from "zod";
import type { Tool } from "../core/types.js";

/**
 * Something noticed on the way past, which is not a scenario's verdict.
 *
 * A verification asks a fixed question of each scenario and records what happened. But a person watching a
 * screen sees more than the question asked: a label that should be there and is not, prose rendered as raw
 * markdown, a number formatted wrongly. Reported from a live session — "testi tamamlamıyorum, test esnasında
 * farkettiğim bulguyu söylüyorum".
 *
 * Recording that as FAILED would be two lies in one: the scenario was not run to completion, and the thing
 * that is wrong is not what the scenario was asking about. So a finding is its own kind of thing — it has no
 * verdict, it has a life of its own, and it is closed by being fixed rather than by being re-run.
 *
 * The tester REPORTS findings and never fixes them. Changing the product mid-verification would mean the
 * thing verified is not the thing that shipped, and the role that writes the code has to be a different one.
 */

export interface Finding {
  /** Short, in the product's terms — this becomes the task's title. */
  title: string;
  /** What is wrong, where it was seen, and what should have happened instead. */
  detail: string;
  /** Repo-relative files it appears to involve, when the tester can name them. Advisory. */
  files: string[];
  /** What must hold for this to be settled — the acceptance criteria of the card it becomes. */
  acceptance: string[];
  /** The scenario that was being run when it surfaced, if any — so the report can say where it came from. */
  scenario?: string;
}

export const FindingSchema = z.object({
  title: z.string().describe("Short, in the product's terms — e.g. \"Summary screen omits the Product Description label\"."),
  detail: z.string().describe("What is wrong, where you saw it, and what should have happened instead."),
  files: z.array(z.string()).default([]).describe("Repo-relative files this appears to involve, if you can name them."),
  acceptance: z.array(z.string()).default([]).describe("What must be true for this to be settled. One checkable statement per line."),
  scenario: z.string().optional().describe("The scenario id you were running when you noticed it, if any."),
});

/** Findings raised during one verification, in the order they were noticed. */
export class FindingQueue {
  private readonly items: Finding[] = [];
  private taken = 0;

  add(f: Finding): number {
    this.items.push(f);
    return this.items.length;
  }

  /** The ones not yet handed to a fix — drained once, so a resumed loop does not re-fix what it fixed. */
  drain(): Finding[] {
    const out = this.items.slice(this.taken);
    this.taken = this.items.length;
    return out;
  }

  all(): Finding[] { return [...this.items]; }
  get length(): number { return this.items.length; }
}

/**
 * The tester's way to raise one — a tool, not a convention.
 *
 * A sentence in prose would have to be parsed back out of the transcript, and a finding has structure that
 * matters: what must be true for it to be settled is the acceptance criteria of the card it becomes, and
 * asking for it here is what stops the fix from being judged by whether it looks done.
 */
export function buildReportFindingTool(queue: FindingQueue): Tool {
  return {
    name: "report_finding",
    description:
      "Report something wrong that you noticed, which is NOT the verdict of a scenario. Use it when the "
      + "product misbehaves in a way the current scenario was not asking about, or when the developer points "
      + "something out. It is recorded, and a separate role fixes it — you never fix it yourself. Give the "
      + "acceptance criteria: what must be true for it to be settled.",
    permissionLevel: "safe",
    parameters: FindingSchema,
    describe: (args) => ({
      allowKey: "finding:report",
      preview: `finding: ${String((args as { title?: unknown }).title ?? "").slice(0, 80)}`,
    }),
    async run(rawArgs) {
      const parsed = FindingSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `report_finding: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const n = queue.add(parsed.data);
      return {
        content: `Finding #${n} recorded: "${parsed.data.title}". It will be triaged and fixed by another role. `
          + `Carry on with the scenario you were running — do not fix it yourself, and do not mark the `
          + `scenario failed because of it.`,
        isError: false,
      };
    },
  };
}

/** How the report shows findings — separate from the scenario table, because it is a different kind of thing. */
export function describeFindings(findings: Finding[]): string {
  if (!findings.length) return "";
  const rows = findings.map((f, i) => `${i + 1}. **${f.title}**${f.scenario ? ` (noticed during ${f.scenario})` : ""}\n   ${f.detail}`);
  return `## Findings\n\n_Noticed in passing, not the verdict of any scenario._\n\n${rows.join("\n")}\n`;
}
