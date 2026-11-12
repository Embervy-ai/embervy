import { afterEach, describe, expect, test } from "bun:test";
import worker from "./src/index";

// watch / listen / see_video are offered only with a video backend
// (VIDEO_BACKEND_URL). The installer leaves it empty; then the agent must not
// see tools that can only fail. A call by name still gets the clear error.
// No network: a configured backend is answered by a stub.

const KEY = "memory-test-key-0123456789";
const VIDEO = ["listen", "see_video", "watch"];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function mcp(env: Record<string, unknown>, method: string, params?: unknown): Promise<any> {
  const res = await worker.fetch(new Request("https://memory.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), { EMBERVY_API_KEY: KEY, ...env } as any);
  expect(res.status).toBe(200);
  return res.json();
}
const listed = async (env: Record<string, unknown>) =>
  ((await mcp(env, "tools/list")).result.tools as Array<{ name: string }>).map((t) => t.name);

describe("video tools follow VIDEO_BACKEND_URL", () => {
  test("unset or blank: the three video tools are not listed; every other tool still is", async () => {
    const full = await listed({ VIDEO_BACKEND_URL: "https://video.example/api" });
    for (const env of [{}, { VIDEO_BACKEND_URL: "" }, { VIDEO_BACKEND_URL: "   " }]) {
      const names = await listed(env);
      expect(names.filter((n) => VIDEO.includes(n))).toEqual([]);
      expect(names).toEqual(full.filter((n) => !VIDEO.includes(n)));
    }
  });

  test("set: watch, listen and see_video are listed", async () => {
    const names = await listed({ VIDEO_BACKEND_URL: "https://video.example/api" });
    expect(names.filter((n) => VIDEO.includes(n)).sort()).toEqual(VIDEO);
  });

  test("called by name without a backend: the clear error, no request goes out", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => { calls.push(String(input)); return new Response("{}"); }) as any;
    for (const env of [{}, { VIDEO_BACKEND_URL: "  " }]) {
      for (const name of VIDEO) {
        const reply = await mcp(env, "tools/call", { name, arguments: { url: "https://media.example/v/1" } });
        expect(reply.error.message).toContain(`${name}: VIDEO_BACKEND_URL env var not set`);
      }
    }
    expect(calls).toEqual([]);
  });

  test("with a backend the call goes to it (the value is trimmed)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return Response.json({ title: "Clip", frames: [] });
    }) as any;
    const reply = await mcp({ VIDEO_BACKEND_URL: " https://video.example/api " }, "tools/call", { name: "see_video", arguments: { url: "https://media.example/v/1" } });
    expect(reply.result.content[0].text).toContain("Clip");
    expect(calls).toEqual(["https://video.example/api/watch"]);
  });
});
