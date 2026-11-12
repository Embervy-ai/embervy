import { expect, test } from "bun:test";
import { appReplyId, replyQuoteFromId } from "./message-fields";

test("inbox quotes use the user role and flatten line breaks", () => {
  expect(replyQuoteFromId("question", [{ id: "question", text: "First\r\nSecond" }], [])).toEqual({ id: "question", snippet: "First Second", role: "user" });
});

test("mail quotes never identify the sender as the owner", () => {
  expect(replyQuoteFromId("mail", [{ id: "mail", source: "email", text: "Foreign mail" }], [])).toEqual({ id: "mail", snippet: "Foreign mail", role: "email" });
});

test("outbox quotes use the assistant role", () => {
  expect(replyQuoteFromId("answer", [], [{ id: "answer", text: "Answer", role: "user" }])).toEqual({ id: "answer", snippet: "Answer", role: "assistant" });
});

test("unknown and unsafe ids have no quote", () => {
  for (const id of [undefined, null, "", "unknown", "../bad", "x\"", "x".repeat(65), {}, NaN]) {
    expect(replyQuoteFromId(id, [], [])).toBeUndefined();
  }
  expect(appReplyId("x\"")).toBeUndefined();
  expect(appReplyId("room-123")).toBeUndefined();
  expect(appReplyId("safe.id:123")).toBe("safe.id:123");
});

test("room, scheduled and reaction entries cannot be quoted from either store", () => {
  for (const entry of [
    { id: "room-123", text: "Room" },
    { id: "hidden", text: "Room", source: "room" },
    { id: "moment", text: "[gateway:silent] A moment.", source: "scheduled" },
    { id: "reaction", text: "Reaction", type: "reaction" },
  ]) {
    expect(replyQuoteFromId(entry.id, [entry], [])).toBeUndefined();
    expect(replyQuoteFromId(entry.id, [], [entry])).toBeUndefined();
  }
});

test("long quotes are limited to 160 characters", () => {
  expect(replyQuoteFromId("long", [{ id: "long", text: "a".repeat(200) }], [])?.snippet).toBe("a".repeat(160));
});

test("numeric ids match their stored representation and empty text has no quote", () => {
  expect(replyQuoteFromId("123", [{ id: 123, text: "Text" }], [])?.id).toBe("123");
  expect(replyQuoteFromId("empty", [{ id: "empty", text: "" }], [])).toBeUndefined();
});
