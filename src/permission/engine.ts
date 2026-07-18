import type { PermissionLevel, PermissionMode } from "../core/types.js";
import { matchesAllowlist, isDangerous } from "./rules.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRequest {
  level: PermissionLevel;
  preview: string;
  allowKey: string; // shell: komut · dosya: hedef yol
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
    // safe her zaman serbest.
    if (req.level === "safe") return "allow";

    // Allowlist eşleşmesi her modda geçerli (tehlikeli değilse).
    const isExec = req.level === "exec";
    const dangerous = isExec && isDangerous(req.allowKey);

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
