import type { PermissionLevel, PermissionMode } from "../core/types.js";
import { matchesAllowlist, isDangerous, isReadOnly } from "./rules.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRequest {
  level: PermissionLevel;
  preview: string;
  allowKey: string; // shell: command · file: target path
}

export class PermissionEngine {
  private _mode: PermissionMode;
  private allowlist: string[];

  constructor(opts: { mode: PermissionMode; allowlist: string[] }) {
    this._mode = opts.mode;
    this.allowlist = [...opts.allowlist];
  }

  get mode(): PermissionMode {
    return this._mode;
  }

  setMode(m: PermissionMode): void {
    this._mode = m;
  }

  addAllow(rule: string): void {
    if (!this.allowlist.includes(rule)) this.allowlist.push(rule);
  }

  check(req: PermissionRequest): PermissionDecision {
    // safe is always free.
    if (req.level === "safe") return "allow";

    // Allowlist match is valid in every mode (unless dangerous).
    const isExec = req.level === "exec";
    const dangerous = isExec && isDangerous(req.allowKey);

    // Inspecting the workspace is how an agent orients itself. A command proven to only READ cannot change a
    // byte, so prompting for it buys no safety and turns an autonomous run into a clicking exercise. This is
    // deliberately ABOVE the mode switch: even in "ask", `git status` and `grep` are not decisions worth making.
    if (isExec && !dangerous && isReadOnly(req.allowKey)) return "allow";

    const kind = req.level === "write" ? "glob" : "prefix";
    if (!dangerous && matchesAllowlist(req.allowKey, this.allowlist, kind)) {
      return "allow";
    }

    switch (this._mode) {
      case "ask":
        return "ask";
      case "acceptEdits":
        return req.level === "write" ? "allow" : "ask";
      case "auto":
        return dangerous ? "ask" : "allow";
    }
  }
}
