import { describe, expect, test } from "bun:test";
import { chatToResponsesInput } from "./chatgpt-oauth-adapter.ts";

// Preserve every system message so multiple instruction blocks remain effective.

describe("chatToResponsesInput: system messages", () => {
  test("without a system message the default instruction stays", () => {
    const { instructions, input } = chatToResponsesInput([{ role: "user", content: "hi" }]);
    expect(instructions).toBe("You are a helpful assistant.");
    expect(input).toHaveLength(1);
  });

  test("a single system message comes through unchanged", () => {
    const { instructions } = chatToResponsesInput([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
    expect(instructions).toBe("Be brief.");
  });

  test("several system messages are joined in order, none is dropped", () => {
    const { instructions, input } = chatToResponsesInput([
      { role: "system", content: "First rule." },
      { role: "user", content: "hi" },
      { role: "system", content: "Second rule." },
      { role: "system", content: [{ type: "text", text: "Third" }, { type: "text", text: "rule." }] },
    ]);
    expect(instructions).toBe("First rule.\n\nSecond rule.\n\nThird\nrule.");
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe("user");
  });
});
