/**
 * house-rooms.ts — the rooms seam, without a room.
 *
 * A house can teach Brain how to file messages from outside rooms of its own.
 * The product ships none: no inbox source counts as such a room, no tool is a
 * room tool beyond the app's own `room`, and channel tags keep their usual
 * fields.
 */

type Entry = { source?: unknown };

export function houseForeignSource(_entry: Entry): boolean {
  return false;
}

export function houseRoomTool(_tool: string): boolean {
  return false;
}

export function houseRoomSpeech(_tool: string, _input: { text: string; action?: unknown }): string | null | undefined {
  return undefined;
}

export function houseChannelWho(_entry: Entry): Array<[string, string]> | null {
  return null;
}
