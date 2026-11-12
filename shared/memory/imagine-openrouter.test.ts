import { describe, expect, test } from "bun:test";
import { openRouterImage } from "./src/index";

// imagine's last way: an image over OpenRouter's image endpoint, paid from the
// house's OpenRouter key. No network: the fetcher is a stub that records what
// it was asked and answers like the endpoint.

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));

function stub(answer: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("imagine over OpenRouter", () => {
  test("asks the image endpoint with the house key, Flux 3 by default, the right aspect; returns the bytes", async () => {
    const { calls, fetcher } = stub(() => Response.json({ data: [{ b64_json: PNG, media_type: "image/png" }] }));
    const out = await openRouterImage({ OPENROUTER_API_KEY: "or-test-key" }, "a small house at dawn", undefined, 1280, 720, fetcher);
    expect("bytes" in out && new Uint8Array(out.bytes)[0]).toBe(0x89);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer or-test-key");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ model: "black-forest-labs/flux-3-image", prompt: "a small house at dawn", n: 1, aspect_ratio: "16:9" });
    expect(body.input_references).toBeUndefined();
  });

  test("a reference image goes along as an input reference; the model can be chosen", async () => {
    const { calls, fetcher } = stub(() => Response.json({ data: [{ b64_json: PNG }] }));
    await openRouterImage({ OPENROUTER_API_KEY: "k", OPENROUTER_IMAGE_MODEL: "bytedance-seed/seedream-5-0-flash" }, "p", "data:image/jpeg;base64,AAAA", 1024, 1024, fetcher);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe("bytedance-seed/seedream-5-0-flash");
    expect(body.input_references).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }]);
  });

  test("an empty or limited key says so in words", async () => {
    const { fetcher } = stub(() => new Response("insufficient credits", { status: 402 }));
    const out = await openRouterImage({ OPENROUTER_API_KEY: "k" }, "p", undefined, 1024, 1024, fetcher);
    expect("error" in out && out.error).toContain("credit or limit is used up");
  });

  test("an answer without an image is no image", async () => {
    const { fetcher } = stub(() => Response.json({ data: [] }));
    const out = await openRouterImage({ OPENROUTER_API_KEY: "k" }, "p", undefined, 1024, 1024, fetcher);
    expect(out).toEqual({ error: "OpenRouter: no image in the answer" });
  });
});
