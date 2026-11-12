import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const g = createRequire(import.meta.url)("./public/games.js");

for (const [game, good, expected, bad] of [
  ["c4", "[move: 7]", 6, ["[MOVE: 0]", "[MOVE: 8]", "[MOVE: 12]", "[MOVE: 1 ]", "MOVE: 1"]],
  ["ttt", "[TTT: 9]", 8, ["[TTT: 0]", "[TTT: 10]", "[TTT: -1]"]],
  ["sb", "[shot: j10]", { r: 9, c: 9 }, ["[SHOT: A0]", "[SHOT: K1]", "[SHOT: A11]", "[SHOT: A100]"]],
  ["db", "[edge: v 4 6]", { kind: "V", r: 4, c: 6 }, ["[EDGE: H 6 0]", "[EDGE: V 5 0]", "[EDGE: H -1 0]", "[EDGE: X 0 0]"]]
] as const) {
  test(`${game}: strict markers and first matching marker only`, () => {
    expect(g.parseMove(game, good)).toEqual(expected);
    expect(g.parseMove(game, good + " " + good)).toEqual(expected);
    for (const text of bad) expect(g.parseMove(game, text)).toBeNull();
    expect(g.parseMove(game, null)).toBeNull();
  });
}
test("multiple distinct markers use the first, not a batch", () => {
  expect(g.parseMove("c4", "[MOVE: 2] [MOVE: 5]")).toBe(1);
  expect(g.parseMove("ttt", "[TTT: 1] [TTT: 9]")).toBe(0);
  expect(g.parseMove("sb", "[SHOT: A1] [SHOT: J10]")).toEqual({ r: 0, c: 0 });
  expect(g.parseMove("db", "[EDGE: H 0 0] [EDGE: V 1 1]")).toEqual({ kind: "H", r: 0, c: 0 });
});
for (const [dr, dc, r, c] of [[0,1,5,0],[1,0,0,2],[1,1,1,1],[1,-1,1,5]]) {
  test(`connect four winner direction ${dr},${dc}`, () => {
    const board = g.grid(6,7);
    expect(g.winningCells(board, 1)).toBeNull();
    for (let k = 0; k < 4; k++) board[r + dr*k][c + dc*k] = 1;
    expect(g.winningCells(board, 1)).toHaveLength(4);
    expect(g.winningCells(board, 2)).toBeNull();
  });
}
test("drop is immutable and rejects full or invalid columns", () => {
  let board = g.grid(6,7);
  const next = g.drop(board, 0, 1);
  expect(board[5][0]).toBe(0); expect(next[5][0]).toBe(1);
  for (let i = 0; i < 6; i++) board = g.drop(board, 0, 1);
  expect(g.drop(board, 0, 2)).toBeNull();
  expect(g.drop(board, -1, 1)).toBeNull();
});
test("tic tac toe rows, columns, diagonals and draw", () => {
  for (const line of [[0,1,2],[0,3,6],[0,4,8],[2,4,6]]) {
    const cells = Array(9).fill(0); line.forEach(i => cells[i] = 2);
    expect(g.tttWinner(cells).who).toBe(2);
  }
  expect(g.tttWinner([1,2,1,1,2,2,2,1,1])).toBeNull();
});
test("battleship hit, miss, sunk and duplicate rejection preserve input", () => {
  const fleet = [[[0,0],[0,1]]], shots = g.grid(10,10);
  const hit = g.shoot(fleet, shots, 0, 0);
  expect(hit.hit).toBe(true); expect(hit.over).toBe(false); expect(shots[0][0]).toBe(0);
  expect(g.shoot(fleet, hit.shots, 0, 0)).toBeNull();
  expect(g.shoot(fleet, hit.shots, 0, 1).over).toBe(true);
  expect(g.shoot(fleet, shots, 9, 9).hit).toBe(false);
});
test("placement rejects overlap and out of bounds", () => {
  const fleet = g.placeShip([], 5, 0, 0, true);
  expect(fleet[0]).toHaveLength(5);
  expect(g.placeShip(fleet, 3, 0, 2, false)).toBeNull();
  expect(g.placeShip([], 5, 9, 9, true)).toBeNull();
});
test("closing a box scores and retains the player's turn", () => {
  let s = g.newDots();
  for (const edge of [{kind:"H",r:0,c:0},{kind:"H",r:1,c:0},{kind:"V",r:0,c:0}]) s = g.setEdge(s, edge, 1).state;
  const result = g.setEdge(s, {kind:"V",r:0,c:1}, 2);
  expect(result.closed).toBe(1); expect(result.state.turn).toBe(2);
  expect(result.state.scores[2]).toBe(1); expect(result.state.owner[0][0]).toBe(2);
  expect(s.owner[0][0]).toBe(0);
  expect(g.setEdge(result.state, {kind:"V",r:0,c:1}, 1)).toBeNull();
});
test("games assets, translations and common receive hook are connected", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const app = read("./public/app.js"), source = read("./public/games.js");
  const en = JSON.parse(read("./strings/en.json"));
  for (const match of source.matchAll(/t\("(games\.[\w]+)"/g)) expect(en[match[1]]).toBeTruthy();
  const games = read("./public/index.html").match(/\/games\.js\?v=\d+(-h\d+)?/)?.[0];
  expect(games).toBeTruthy();
  expect(read("./public/sw.js")).toContain(`${games}"`);
  expect(app).toContain('text.startsWith("[GAME]")');
  expect(app).toContain("handleAgentMessage(text, ts)");
});
