import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Grabs a PNG off the clipboard as raw bytes (undefined if none / unsupported). Injected in tests. */
export type ClipboardCapture = () => Promise<Buffer | undefined>;

export interface ClipboardDeps {
  platform?: string; // process.platform (injectable)
  capture?: ClipboardCapture; // overrides the platform capture (tests)
}

/**
 * Reads an image from the clipboard → a base64 data URI (data:image/png;base64,…), or undefined if the
 * clipboard holds no image or the platform is unsupported. macOS-only in production (uses osascript).
 */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const capture = deps.capture ?? (platform === "darwin" ? captureDarwin : async (): Promise<undefined> => undefined);
  const buf = await capture();
  if (!buf || buf.length === 0) return undefined;
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/** macOS: dump the clipboard's PNG data to a temp file via osascript, then read + delete it. */
const captureDarwin: ClipboardCapture = async () => {
  const file = join(tmpdir(), `hc-paste-${process.pid}-${Date.now()}.png`);
  const script = [
    `set outFile to (POSIX file "${file}")`,
    "try",
    "  set imgData to (the clipboard as «class PNGf»)",
    "on error",
    '  return "NONE"',
    "end try",
    "set fh to open for access outFile with write permission",
    "try",
    "  write imgData to fh",
    "  close access fh",
    "on error",
    "  try",
    "    close access fh",
    "  end try",
    '  return "NONE"',
    "end try",
    'return "OK"',
  ].join("\n");
  const ok = await new Promise<boolean>((resolve) => {
    execFile("osascript", ["-e", script], (err, stdout) => resolve(!err && stdout.trim() === "OK"));
  });
  if (!ok) return undefined;
  try {
    return await readFile(file);
  } catch {
    return undefined;
  } finally {
    void rm(file, { force: true }).catch(() => { /* temp cleanup is best-effort */ });
  }
};
