/**
 * The `calendar` MCP tool, used by the app's MCP bridge (Claude/app/mcp.ts).
 * Talks to the app over /api/internal/calendar* with the
 * INTERNAL_API_TOKEN bearer (the cookie-guarded /api/calendar is the
 * browser's door, not the agent's).
 */

export function calendarToolDefinition(userLabel: string) {
  return {
    name: "calendar",
    description:
      `Your own calendar in the app — it survives sessions. add / list / remove your entries (house-local date and time). ` +
      `When the calendar module is on, ${userLabel} can subscribe to it read-only on their phone: every entry shows there with title and time only (never the note) unless you add it with private=true. ` +
      `list also shows ${userLabel}'s own appointments from their calendar links, read-only and marked as theirs. ` +
      `feed returns the subscription link to give ${userLabel} when they ask for it.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["add", "list", "remove", "feed"], description: "What to do" },
        title: { type: "string", description: "Entry title (add)" },
        date: { type: "string", description: "Date YYYY-MM-DD, house-local (add)" },
        time: { type: "string", description: "Optional start HH:MM, 24h, house-local; omit for an all-day entry (add)" },
        end: { type: "string", description: "Optional end HH:MM on the same day (add)" },
        note: { type: "string", description: "Optional note — stays in the house, never in the phone feed (add)" },
        private: { type: "boolean", description: "true keeps this entry off the phone feed entirely (add)" },
        id: { type: "string", description: "Entry id (remove)" },
        days: { type: "number", description: "How many days of their calendar to show, 1-30, default 14 (list)" },
      },
      required: ["action"],
    },
  };
}

type ToolResult = { content: { type: "text"; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

export async function callCalendarTool(
  args: Record<string, unknown> | undefined,
  o: { baseUrl: string; headers: () => Record<string, string>; fetchImpl?: typeof fetch },
): Promise<ToolResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const action = String(args?.action ?? "");
  const api = `${o.baseUrl}/api/internal/calendar`;
  try {
    let res: Response;
    if (action === "add") {
      res = await doFetch(api, {
        method: "POST",
        headers: o.headers(),
        body: JSON.stringify({
          title: args?.title,
          date: args?.date,
          time: args?.time,
          end: args?.end,
          note: args?.note,
          private: args?.private === true,
        }),
      });
    } else if (action === "list") {
      const days = Number(args?.days);
      res = await doFetch(`${api}${Number.isFinite(days) && days > 0 ? `?days=${Math.round(days)}` : ""}`, { headers: o.headers() });
    } else if (action === "remove") {
      if (!args?.id) return text("remove needs the entry id (see list)");
      res = await doFetch(`${api}/delete`, { method: "POST", headers: o.headers(), body: JSON.stringify({ id: args.id }) });
    } else if (action === "feed") {
      res = await doFetch(`${api}/feed`, { headers: o.headers() });
    } else {
      return text("action required: add, list, remove, feed");
    }
    const body = await res.text();
    if (!res.ok) return text(`Calendar ${action} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    return text(body);
  } catch (err) {
    return text(`Calendar error: ${err}`);
  }
}
