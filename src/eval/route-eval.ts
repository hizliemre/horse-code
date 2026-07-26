import { filesForTask } from "../skills/route.js";
import type { ProjectGraph } from "../engine/project-graph.js";

/**
 * Measuring how well a task resolves to the files it will actually touch.
 *
 * Routing was calibrated on tasks written by the person who had just read the skill descriptions, which
 * proves only that the vocabulary matches itself. This measures the first stage against ground truth we did
 * not author: a commit's subject is a real task description, and the files it changed are the real answer.
 *
 * It is deliberately only the FIRST stage. Whether the right skill was then chosen depends on the skill
 * descriptions and on what kind of project the corpus is, and this repository is a poor corpus for that —
 * its commit subjects are not in the language the descriptions are written in, and its `.tsx` files are
 * terminal UI rather than the web interfaces the design skills describe. File resolution has no such
 * dependency: an identifier is an identifier.
 */

export interface Sample {
  /** A real task description — a commit subject, a card title. */
  subject: string;
  /** The files that were actually changed. Ground truth. */
  files: string[];
}

export interface Metrics {
  samples: number;
  /** Samples where resolution returned at least one file. */
  resolved: number;
  /** Of the files it named, the share that were really touched. */
  precision: number;
  /** Of the files really touched, the share it named. */
  recall: number;
  /** Samples where every named file was really touched. */
  exact: number;
  /**
   * Share of named files whose EXTENSION appears among the files really touched.
   *
   * The measure that matches what routing consumes. Routing never uses a path to open a file — it uses the
   * directory words and the extension to tell what kind of work this is. Naming a sibling component in the
   * same directory is a near-miss on exact paths and a complete success for the decision being made.
   */
  kindPrecision: number;
}

/** Source files only: a commit's lockfile churn is not what a task is about. */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala)$/;

export function codeFiles(files: string[]): string[] {
  return files.filter((f) => CODE.test(f) && !/(^|\/)(dist|node_modules|vendor)\//.test(f));
}

/**
 * Scores file resolution over a corpus.
 *
 * Samples whose commit touched no source file are dropped rather than counted as failures — a documentation
 * commit has no files to resolve to, so scoring it would measure the corpus, not the resolver.
 */
export function evaluateFileResolution(samples: Sample[], graph: ProjectGraph, max = 8): Metrics {
  let resolved = 0, exact = 0, tp = 0, predicted = 0, actual = 0, used = 0, kindHits = 0;
  for (const s of samples) {
    const truth = new Set(codeFiles(s.files));
    if (!truth.size) continue;
    used++;
    const got = filesForTask(s.subject, graph, max);
    if (got.length) resolved++;
    predicted += got.length;
    actual += truth.size;
    const hits = got.filter((f) => truth.has(f)).length;
    tp += hits;
    const ext = (f: string): string => f.split(".").pop() ?? "";
    const truthExts = new Set([...truth].map(ext));
    kindHits += got.filter((f) => truthExts.has(ext(f))).length;
    if (got.length && hits === got.length) exact++;
  }
  return {
    samples: used,
    resolved,
    precision: predicted ? tp / predicted : 0,
    recall: actual ? tp / actual : 0,
    exact,
    kindPrecision: predicted ? kindHits / predicted : 0,
  };
}

/** Parses `git log --format="___%s" --name-only` into samples. */
export function parseGitLog(raw: string): Sample[] {
  const out: Sample[] = [];
  for (const block of raw.split("___").slice(1)) {
    const [subject, ...files] = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (subject) out.push({ subject, files });
  }
  return out;
}

const UI_FILE = /\.(tsx|jsx|css|scss|vue|svelte)$/;

export interface UiMetrics {
  tp: number; fp: number; fn: number; tn: number;
  precision: number;
  recall: number;
  accuracy: number;
  /** What "always answer no" would score. A skewed corpus makes a useless classifier look good. */
  baselineAccuracy: number;
}

/**
 * The decision routing actually makes: is this task interface work?
 *
 * Reported separately from file precision because that number flatters itself on a repository where 86% of
 * changed files share one extension — guessing the majority extension would score 86% while carrying no
 * information at all.
 */
export function evaluateUiDetection(samples: Sample[], graph: ProjectGraph, max = 3): UiMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of samples) {
    const truth = codeFiles(s.files);
    if (!truth.length) continue;
    const predicted = filesForTask(s.subject, graph, max).some((f) => UI_FILE.test(f));
    const actual = truth.some((f) => UI_FILE.test(f));
    if (predicted && actual) tp++;
    else if (predicted) fp++;
    else if (actual) fn++;
    else tn++;
  }
  const total = tp + fp + fn + tn || 1;
  return {
    tp, fp, fn, tn,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    accuracy: (tp + tn) / total,
    baselineAccuracy: (tn + fp) / total,
  };
}
