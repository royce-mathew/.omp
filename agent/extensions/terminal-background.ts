import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SET_OXOCARBON_BACKGROUND = "\x1b]11;rgb:1616/1616/1616\x07";
const RESTORE_TERMINAL_BACKGROUND = "\x1b]111\x07";

export default function terminalBackground(pi: ExtensionAPI): void {
  let applied = false;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.stdout.isTTY || applied) return;
    process.stdout.write(SET_OXOCARBON_BACKGROUND);
    applied = true;
  });

  pi.on("session_shutdown", () => {
    if (!applied) return;
    process.stdout.write(RESTORE_TERMINAL_BACKGROUND);
    applied = false;
  });
}
