// The HyperFrames CLI, pinned so a member's render matches ours. Runs locally, no account.
import { run } from "./media.mjs";

export const HF_VERSION = "0.9.46";
const win = process.platform === "win32";
// shortcut: Windows needs a shell for npx.cmd, so each arg is quoted by hand; untested on Windows.
const q = (a) => (win ? `"${a}"` : a);

export function hf(args, opts = {}) {
  return run("npx", ["--yes", `hyperframes@${HF_VERSION}`, ...args].map(q), {
    ...opts,
    shell: win,
    env: { ...process.env, DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", ...opts.env },
  });
}
