# Provenance

`SKILL.md` is a **verbatim copy** of the `brainstorming` skill from the `superpowers` plugin:

- source: `superpowers/skills/brainstorming/SKILL.md`
- version: `6.1.1`

Do not edit it. Keeping it byte-identical is what makes it re-syncable when the upstream skill changes — a
local tweak would be silently overwritten on the next sync, or worse, quietly diverge and stay.

## Where the horse-code specifics live

The skill describes a METHOD, and parts of it name conventions from its original habitat that do not exist
here: a `docs/superpowers/specs/…` output path, "invoke the writing-plans skill" as the terminal step, a
browser-based visual companion, and a task list per checklist item.

Those are mapped onto this pipeline in the **`brainstormer` role prompt** (`src/prompts.ts`), not in this
file: the skill stays the authority on *how to brainstorm*, the role prompt is the authority on *where the
output goes and what happens next*. In horse-code the brainstorm is followed by the SPEC stage, its brief is
written to `specs/NNN-slug/brainstorm.md`, and questions go through the `ask_user` tool.

Only `SKILL.md` is read by the loader; every other file in this directory is documentation.
