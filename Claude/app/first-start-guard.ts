// Terminal questions read Enter as an answer, so chat needs positive evidence of an input box.
export const FIRST_START_NOTICE = "Your agent is waiting for a first-start question in its terminal. Open TUI at the top and answer it, then write again.";
export const UNKNOWN_INPUT_NOTICE = "Your agent is waiting in its terminal for something the app does not recognise; open TUI at the top and inspect it, then write again.";

function inspectPane(pane: string) {
  // Line boundaries distinguish quoted dialog text from the live input box.
  const plain = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
  const cues = /Do\s+you\s+trust\s+the\s+files\s+in\s+this\s+folder|Quick\s+safety\s+check|Yes,\s+I\s+trust\s+this\s+folder|Accessing\s+workspace:|Choose\s+the\s+text\s+style|new\s+MCP\s+servers/gi;
  let lastCueEnd = -1;
  for (const match of plain.matchAll(cues)) lastCueEnd = match.index + match[0].length;
  const lines = plain.trimEnd().split("\n");
  const lastCueLine = lastCueEnd < 0 ? -1 : plain.slice(0, lastCueEnd).split("\n").length - 1;
  const isRule = (line: string) => /^─{10,}$/.test(line.trim());
  let laterBox = false, bottomBox = false;
  // Wrapped input can dismiss quoted setup cues, but must not receive appended chat text.
  for (let input = lastCueLine + 2; input < lines.length; input++) {
    if (!isRule(lines[input - 1]) || !/^[❯›>]/.test(lines[input].trimStart())) continue;
    for (let bottom = input + 1; bottom <= input + 4 && bottom < lines.length; bottom++) {
      if (!isRule(lines[bottom])) continue;
      laterBox = true;
      // Leave room for the short status footer, not an input box buried in output.
      if (bottom === input + 1 && lines.length - bottom - 1 <= 3) bottomBox = true;
      break;
    }
  }
  return { empty: !plain.trim(), known: lastCueEnd >= 0 && !laterBox, bottomBox };
}

export function hasFirstStartDialog(pane: string): boolean {
  return inspectPane(pane).known;
}

export type InputReadiness = "ready" | "known" | "unknown";
export function inputReadiness(pane: string): InputReadiness {
  const screen = inspectPane(pane);
  if (screen.known) return "known";
  return screen.empty || screen.bottomBox ? "ready" : "unknown";
}

export async function deliverUnlessFirstStart(
  capture: () => Promise<string>,
  send: () => void | Promise<void>,
  notice: (text: string) => void | Promise<void>,
  mode?: string,
): Promise<boolean> {
  // A missing pane is normal before wake: keep the message in the inbox for that agent.
  const pane = await capture().catch(() => "");
  const state = inputReadiness(pane);
  if (state === "known" || (state === "unknown" && mode !== "known")) {
    await notice(state === "known" ? FIRST_START_NOTICE : UNKNOWN_INPUT_NOTICE);
    return false;
  }
  await send();
  return true;
}
