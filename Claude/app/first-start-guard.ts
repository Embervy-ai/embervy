// Terminal questions read Enter as an answer, so chat needs positive evidence of an input box.
export const FIRST_START_NOTICE = "Your agent is waiting for a terminal question. Answer its card if available, or open TUI at the top, then write again.";
export const UNKNOWN_INPUT_NOTICE = "Your agent is waiting in its terminal for something the app does not recognise; open TUI at the top and inspect it, then write again.";

// Mirrors the conservative permission grammar in loop-dialog.sh (tested for parity).
export function hasPermissionDialog(pane: string): boolean {
  const lines = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").trimEnd().split("\n").map(line => line.trim());
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!/^─{10,}$/.test(lines[start])) continue;
    if (start > 0 && /^─+$/.test(lines[start - 1])) continue;
    const block = lines.slice(start + 1);
    if (block[0] !== "Bash command") continue;
    const heading = block.indexOf("Do you want to proceed?");
    const rules = block.slice(1, heading).flatMap((line, i) => /^╌{10,}$/.test(line) ? [i + 1] : []);
    if (heading < 0 || rules.length !== 2 || rules[1] <= rules[0] + 1) continue;
    if (!block.slice(rules[0] + 1, rules[1]).every(Boolean)) continue;
    const notice: string[] = [];
    let warned = false, valid = true;
    const warning = /^⚠ Claude Code will automatically block this request in ([0-9]+):([0-5][0-9]), to avoid holding up an unattended session$/;
    for (let i = rules[1] + 1; i < heading; i++) {
      const line = block[i];
      if (!line || line.startsWith("│")) notice.push(line);
      else if (line.startsWith("⚠") && !warned) {
        if (!warning.test(line)) {
          if (i + 1 >= heading || !warning.test(line + " " + block[i + 1])) { valid = false; break; }
          i++;
        }
        warned = true;
        notice.push("⚠ Claude Code will automatically block this request at the deadline, to avoid holding up an unattended session");
      } else { valid = false; break; }
    }
    if (!valid) continue;
    const tail = block.slice(heading + 1).filter(Boolean);
    if (!["Esc to cancel · Tab to amend", "Esc to cancel"].includes(tail.pop() || "")) continue;
    const matches = tail.map(line => /^(?:(❯|>)\s*)?([1-9][0-9]*)\. (.+)$/.exec(line));
    if (![3, 4].includes(matches.length) || matches.some(m => !m) || matches.filter(m => m?.[1]).length !== 1) continue;
    if (!matches.every((m, i) => Number(m![2]) === i + 1)) continue;
    if (matches[0]![3] !== "Yes" || matches.at(-1)![3] !== "No" || !matches.slice(1, -1).every(m => m![3].startsWith("Yes, "))) continue;
    // Bound the actual card text, including blank separators and literal answers.
    const text = [...block.slice(0, rules[0]), "", ...block.slice(rules[0] + 1, rules[1]), "",
      ...notice.map(line => line.replace(/^│ ?/, "")), block[heading], ...matches.map(m => `${m![2]}. ${m![3]}`)].join("\n");
    if (text.length <= 12000 && text.split("\n").length <= 30) return true;
  }
  return false;
}

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
  return { empty: !plain.trim(), known: (lastCueEnd >= 0 && !laterBox) || hasPermissionDialog(plain), bottomBox };
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
