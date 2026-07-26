# Bundled skills

Every `SKILL.md` here is a **verbatim copy** from upstream:

| skill | source | licence |
|---|---|---|
| `brainstorming` | superpowers 6.1.1 | plugin |
| `test-driven-development` | superpowers 6.1.1 | plugin |
| `writing-plans` | superpowers 6.1.1 | plugin |
| `systematic-debugging` | superpowers 6.1.1 | plugin |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 (`LICENSE.txt` shipped alongside) |

Do not edit them. Byte-identical is what makes them re-syncable when the upstream skill changes — a local
tweak would either be silently overwritten on the next sync, or quietly diverge and stay.

| skill | attached to | how |
|---|---|---|
| `brainstorming` | `brainstormer` | mandatory |
| `test-driven-development` | `coder`, `senior-coder` | mandatory |
| `writing-plans` | `project-manager` | mandatory |
| `systematic-debugging` | — | discoverable |
| `frontend-design` | `designer`, `senior-designer` | mandatory |

**Mandatory** skills are inlined into the role's system prompt (`applySkills`). **Discoverable** ones appear
only as a one-line entry in the listing every role receives, and are fetched on demand with the `skill` tool —
right for guidance that is only needed when something is stuck, and wasteful to inline into every prompt.

## Where the horse-code specifics live

Each skill describes a METHOD, and parts of it name conventions from its original habitat that do not exist
here: `docs/superpowers/…` output paths, "dispatch a subagent", "invoke the writing-plans skill", a
browser-based visual companion, TodoWrite task lists.

Those are mapped onto this pipeline in the **role prompts** (`src/prompts.ts`), never by editing a skill:

- the skill is the authority on *how the work is done*,
- the role prompt is the authority on *where the output goes, what this pipeline already owns, and what
  happens next*.

Notably `writing-plans` is bound to the TASKS stage, not the plan stage. spec-kit's own `plan` template
already governs `plan.md` (Technical Context, Constitution Check, Project Structure); a second competing
template there would fight it. What spec-kit's *tasks* template does not supply is what makes an individual
task executable — exact paths, a real test cycle, no placeholders — and that is what the skill contributes.

## Overriding

A project may replace any of these by defining a skill of the same name in `<project>/.horsecode/skills/`.
Built-ins load first and the registry is keyed by name, so the project's version wins.

## Dispatcher skills

A skill may be a **dispatcher**: a small `SKILL.md` that routes to sibling documents ("see
`reference/critique.md`"). The loader records each skill's directory, and the `skill` tool reads those
documents on demand — `skill({name, file})`.

On demand is the point. A dispatcher's entry point is small enough to sit in a prompt while its reference
tree can run to megabytes; loading the tree up front would cost far more on every call than the guidance is
worth on the rare call that needs it. Paths are contained to the skill's own directory and capped in size.

## Still not adopted, and why

- [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) (Apache-2.0) — its SKILL.md points at
  `reference/` **29 times** across ~40 documents. Shipping the entry point alone would leave dangling
  pointers.
- [`nextlevelbuilder/ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT) —
  not one skill but seven, and two of them (`ui-styling` at 5.7 MB, `ui-ux-pro-max` at 1.7 MB) are libraries.
  Cherry-picking a single self-contained one (e.g. `design-system`) is the only sane path.
- [`AccessLint/skills`](https://github.com/AccessLint/skills) — a plugin of three skills that additionally
  depend on an MCP server (`mcp__accesslint__*`) and the `@accesslint/cli`. It also carries **no licence**,
  which has to be settled before any of it is vendored here.

## Not adopted

`using-git-worktrees`, `subagent-driven-development`, `executing-plans`, `dispatching-parallel-agents` and
`finishing-a-development-branch` describe work this engine already does itself (worktree lifecycle, the wave
engine, the review ladder, the PR flow). Shipping them would put two systems in charge of the same thing.

`requesting-code-review` is likewise superseded: this pipeline runs its own staged review (per-stage finder
lenses → council → judge).

Only `SKILL.md` is read by the loader; every other file in these directories is documentation.
