import { timingSafeEqual } from "node:crypto";
import { tr } from "./texts";

export interface ControlEndpointDeps {
  token?: string;
  port: number;
  handle: (name: string, args: unknown) => Promise<{ ok: boolean; text?: string; error?: string }>;
  serve: (options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Promise<Response>;
  }) => unknown;
  log?: (event: Record<string, unknown>) => void;
  tools?: readonly string[];
  /** GET /heads serves menu choices; refresh=1 bypasses catalog TTLs. Same bearer as /tool. */
  heads?: (refresh: boolean) => unknown | Promise<unknown>;
}

function bearerMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Placeholders from templates or sanitized packages are NOT a token. An
 * actively set `REPLACE_ME` would otherwise start the listener with a guessable
 * bearer. A short token counts as guessable too. */
export function controlTokenUnusableReason(token: string | undefined): string | null {
  if (!token) return "token_missing";
  if (/^(REPLACE_ME|REPLACEME|CHANGE_?ME|TODO|SET_?ME|PLACEHOLDER|EXAMPLE|XXX+)$/i.test(token)) return "token_placeholder";
  if (/^<.*>$/.test(token)) return "token_placeholder";
  if (token.length < 16) return "token_too_short";
  return null;
}

/** localhost is not authentication. Without an explicit, usable token no
 * listener is created at all; with a token, only a matching bearer reaches
 * the real tool dispatcher. */
export function startAuthenticatedControlEndpoint(deps: ControlEndpointDeps): unknown | null {
  const unusable = controlTokenUnusableReason(deps.token);
  if (unusable) {
    deps.log?.({ type: "control_server_disabled", reason: unusable });
    if (unusable !== "token_missing") {
      console.error(tr`[control] BRAIN_CONTROL_TOKEN unusable (${unusable}) — listener stays off. Set a real random token, e.g.: openssl rand -hex 32`);
    }
    return null;
  }
  try {
    const server = deps.serve({
      port: deps.port,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        const tool = request.method === "POST" && url.pathname === "/tool";
        const heads = request.method === "GET" && url.pathname === "/heads" && Boolean(deps.heads);
        if (!tool && !heads) {
          return new Response("not found", { status: 404 });
        }
        if (!bearerMatches(request.headers.get("authorization"), deps.token!)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        if (heads) {
          try { return Response.json(await deps.heads!(url.searchParams.get("refresh") === "1")); }
          catch (error: any) {
            deps.log?.({ type: "control_heads_failed", error: String(error?.message ?? error) });
            return Response.json({ ok: false, error: "heads unavailable" }, { status: 500 });
          }
        }
        let body: any;
        try { body = await request.json(); }
        catch { return Response.json({ ok: false, error: "invalid json" }, { status: 400 }); }
        const result = await deps.handle(String(body?.name ?? ""), body?.args);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      },
    });
    deps.log?.({ type: "control_server_started", port: deps.port, tools: [...(deps.tools ?? [])], auth: "bearer", ...(deps.heads ? { routes: ["POST /tool", "GET /heads"] } : {}) });
    return server;
  } catch (error: any) {
    deps.log?.({ type: "control_server_failed", port: deps.port, error: String(error?.message ?? error) });
    return null;
  }
}
