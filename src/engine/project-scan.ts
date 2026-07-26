/**
 * What kind of project is this, as FACTS rather than an impression.
 *
 * A skill is guidance an agent will follow, so attaching the wrong one does active damage: a coding agent
 * handed test-driven-development in a repo that has no tests will build a test suite nobody asked for. The
 * fix is not to ask a model to guess whether the project "seems test-driven" — it is to look.
 *
 * Every fact therefore carries the EVIDENCE that produced it. That is what makes an assignment auditable:
 * "no tests → TDD not assigned" is a claim the user can check, while "the tuner decided" is not.
 *
 * Deliberately dependency-free and offline. It reads the file listing and a handful of manifests; it does not
 * parse source, call a service, or build a graph. Discovery that costs a network round-trip would run on every
 * adjust, and discovery that can fail would make skill assignment fail with it.
 */

export interface ProjectFact {
  /** Machine-readable claim, e.g. "tests" or "ui". */
  key: string;
  value: boolean;
  /** Why we concluded it — file paths or manifest keys, at most a few, for the user to check. */
  evidence: string[];
}

export interface ProjectProfile {
  facts: ProjectFact[];
  languages: string[];
  /** One-line-per-fact rendering for a prompt or a `/roles` note. */
  summary: string;
}

/** How many pieces of evidence to keep per fact. Enough to be checkable, not enough to flood a prompt. */
export const MAX_EVIDENCE = 4;

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.go$|(^|\/)test_[^/]+\.py$|[^/]+_spec\.rb$|[^/]+Test\.java$|(^|\/)src\/test\//;
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html)$/;
const LANG: { re: RegExp; name: string }[] = [
  { re: /\.tsx?$/, name: "typescript" },
  { re: /\.jsx?$/, name: "javascript" },
  { re: /\.py$/, name: "python" },
  { re: /\.go$/, name: "go" },
  { re: /\.rs$/, name: "rust" },
  { re: /\.java$/, name: "java" },
  { re: /\.rb$/, name: "ruby" },
  { re: /\.cs$/, name: "csharp" },
  { re: /\.php$/, name: "php" },
  { re: /\.swift$/, name: "swift" },
  { re: /\.kt$/, name: "kotlin" },
];

/** Test runners whose presence in a manifest is itself evidence, even before any test file exists. */
const TEST_DEPS = ["vitest", "jest", "mocha", "ava", "jasmine", "@playwright/test", "cypress", "pytest", "rspec", "junit"];
const UI_DEPS = ["react", "vue", "svelte", "@angular/core", "solid-js", "preact", "next", "nuxt", "tailwindcss"];

/** Manifests that declare a test runner by their mere existence. */
const TEST_CONFIG = /^(pytest\.ini|tox\.ini|phpunit\.xml|\.rspec|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|karma\.conf\.js)$/;

function take(xs: string[]): string[] {
  return xs.slice(0, MAX_EVIDENCE);
}

/**
 * Builds the profile from a repo's file listing plus the text of any manifests among them.
 *
 * Takes the listing rather than reading the disk itself so the caller controls how it is produced (git is the
 * cheap, gitignore-respecting way) and so this stays testable without a fixture tree.
 */
export function profileProject(files: string[], manifests: Record<string, string> = {}): ProjectProfile {
  const manifestText = Object.values(manifests).join("\n").toLowerCase();

  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const testConfigs = files.filter((f) => TEST_CONFIG.test(f.split("/").pop() ?? ""));
  // A dependency on a runner counts: a project mid-setup has the runner before it has the first test.
  const testDeps = TEST_DEPS.filter((d) => manifestText.includes(`"${d}"`) || new RegExp(`^\\s*${d}\\b`, "m").test(manifestText));
  // npm's placeholder script is the opposite of evidence — it is what `npm init` writes when there are no tests.
  const hasTestScript = /"test"\s*:\s*"(?!.*no test specified)[^"]+"/.test(manifestText);

  const uiFiles = files.filter((f) => UI_FILE.test(f));
  const uiDeps = UI_DEPS.filter((d) => manifestText.includes(`"${d}"`));

  const langCount = new Map<string, number>();
  for (const f of files) {
    for (const { re, name } of LANG) if (re.test(f)) langCount.set(name, (langCount.get(name) ?? 0) + 1);
  }
  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);

  const facts: ProjectFact[] = [
    {
      key: "tests",
      value: testFiles.length > 0 || testConfigs.length > 0 || testDeps.length > 0 || hasTestScript,
      evidence: take([
        ...testFiles.map((f) => f),
        ...testConfigs,
        ...testDeps.map((d) => `dependency: ${d}`),
        ...(hasTestScript ? ["a real `test` script"] : []),
      ]),
    },
    {
      key: "ui",
      value: uiFiles.length > 0 || uiDeps.length > 0,
      evidence: take([...uiFiles, ...uiDeps.map((d) => `dependency: ${d}`)]),
    },
  ];

  const summary = [
    `Languages: ${languages.length ? languages.join(", ") : "unknown"}`,
    ...facts.map((f) => {
      const why = f.evidence.length ? ` (${f.evidence.join(", ")})` : "";
      return f.value ? `Has ${f.key}: yes${why}` : `Has ${f.key}: NO — nothing in the repo indicates it`;
    }),
  ].join("\n");

  return { facts, languages, summary };
}

/** Convenience for callers that only care whether a fact holds. */
export function factHolds(profile: ProjectProfile, key: string): boolean {
  return profile.facts.find((f) => f.key === key)?.value ?? false;
}
