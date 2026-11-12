(function (root) {
  "use strict";
  const grid = (r, c) => Array.from({ length: r }, () => Array(c).fill(0));
  const copy = value => JSON.parse(JSON.stringify(value));
  function parseMove(game, text) {
    if (typeof text !== "string") return null;
    const patterns = { c4: /\[MOVE:\s*([1-7])\]/i, ttt: /\[TTT:\s*([1-9])\]/i, sb: /\[SHOT:\s*([A-J])\s*(\d{1,2})\]/i, db: /\[EDGE:\s*([HV])\s+(\d{1,2})\s+(\d{1,2})\]/i };
    if (!patterns[game]) return null;
    const m = text.match(patterns[game]);
    if (!m) return null;
    if (game === "c4" || game === "ttt") return +m[1] - 1;
    if (game === "sb") return +m[2] >= 1 && +m[2] <= 10 ? { r: +m[2] - 1, c: m[1].toUpperCase().charCodeAt(0) - 65 } : null;
    const edge = { kind: m[1].toUpperCase(), r: +m[2], c: +m[3] };
    return edge.r < (edge.kind === "H" ? 6 : 5) && edge.c < (edge.kind === "H" ? 6 : 7) ? edge : null;
  }
  function winningCells(board, player) {
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const cells = Array.from({ length: 4 }, (_, k) => [r + dr * k, c + dc * k]);
        if (cells.every(([rr, cc]) => board[rr]?.[cc] === player)) return cells;
      }
    }
    return null;
  }
  function drop(board, col, player) {
    if (!Number.isInteger(col) || col < 0 || col > 6 || board[0][col]) return null;
    const next = copy(board);
    for (let r = 5; r >= 0; r--) if (!next[r][col]) { next[r][col] = player; break; }
    return next;
  }
  function tttWinner(cells) {
    for (const line of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) {
      if (cells[line[0]] && line.every(i => cells[i] === cells[line[0]])) return { who: cells[line[0]], line };
    }
    return null;
  }
  function shoot(fleet, shots, r, c) {
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 9 || c < 0 || c > 9 || shots[r][c]) return null;
    const next = copy(shots);
    const hit = fleet.some(ship => ship.some(([rr, cc]) => rr === r && cc === c));
    next[r][c] = hit ? 2 : 1;
    const sunk = fleet.filter(ship => ship.every(([rr, cc]) => next[rr][cc] === 2)).length;
    return { shots: next, hit, sunk, over: sunk === fleet.length };
  }
  function newDots() { return { h: grid(6, 6), v: grid(5, 7), owner: grid(5, 6), scores: [0, 0, 0], turn: 1 }; }
  function setEdge(state, edge, player) {
    const { kind, r, c } = edge;
    if (!Number.isInteger(r) || !Number.isInteger(c) || !["H", "V"].includes(kind)) return null;
    const rows = kind === "H" ? 6 : 5, cols = kind === "H" ? 6 : 7;
    if (r < 0 || r >= rows || c < 0 || c >= cols || state[kind.toLowerCase()][r][c]) return null;
    const next = copy(state);
    next[kind.toLowerCase()][r][c] = player;
    let closed = 0;
    for (let rr = 0; rr < 5; rr++) for (let cc = 0; cc < 6; cc++) {
      if (!next.owner[rr][cc] && next.h[rr][cc] && next.h[rr + 1][cc] && next.v[rr][cc] && next.v[rr][cc + 1]) {
        next.owner[rr][cc] = player; closed++;
      }
    }
    next.scores[player] += closed;
    next.turn = closed ? player : 3 - player;
    return { state: next, closed, over: next.scores[1] + next.scores[2] === 30 };
  }
  function placeShip(fleet, length, r, c, horizontal) {
    const cells = Array.from({ length }, (_, k) => [r + (horizontal ? 0 : k), c + (horizontal ? k : 0)]);
    if (cells.some(([rr, cc]) => rr < 0 || rr > 9 || cc < 0 || cc > 9 || fleet.some(ship => ship.some(([sr, sc]) => sr === rr && sc === cc)))) return null;
    return [...fleet, cells];
  }
  function randomFleet() {
    for (;;) {
      let fleet = [];
      for (const length of [5, 4, 3, 3, 2]) {
        for (let attempt = 0; attempt < 500; attempt++) {
          const next = placeShip(fleet, length, Math.floor(Math.random() * 10), Math.floor(Math.random() * 10), Math.random() < 0.5);
          if (next) { fleet = next; break; }
        }
      }
      if (fleet.length === 5) return fleet;
    }
  }
  const logic = { grid, parseMove, winningCells, drop, tttWinner, shoot, newDots, setEdge, placeShip };
  if (typeof module !== "undefined") module.exports = logic;
  if (!root.document) return;
  let state = null, menu = null, config;
  const t = (key, vars) => config.text(key, vars);
  const coord = (r, c) => String.fromCharCode(65 + c) + (r + 1);
  const title = game => ({ c4: t("games.c4"), sb: t("games.sb"), ttt: t("games.ttt"), db: t("games.db") })[game];
  function element(tag, text, parent, cls) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }
  function button(parent, text, action, disabled = false, cls = "") {
    const el = element("button", text, parent, cls);
    el.type = "button"; el.disabled = disabled; el.addEventListener("click", action);
    return el;
  }
  function close() { state = null; document.getElementById("game-panel")?.replaceChildren(); document.getElementById("game-panel")?.classList.remove("open"); }
  function start(game) {
    state = { game, turn: 1, over: false, winner: 0, started: Date.now(), error: false };
    if (game === "c4") state.board = grid(6, 7);
    if (game === "ttt") state.cells = Array(9).fill(0);
    if (game === "db") state.dots = newDots();
    if (game === "sb") Object.assign(state, { placing: true, horizontal: true, fleets: [null, [], randomFleet()], shots: [null, grid(10, 10), grid(10, 10)] });
    render();
  }
  function shotList(shots, value) {
    return shots.flatMap((row, r) => row.flatMap((v, c) => v === value ? [coord(r, c)] : [])).join(", ") || "none";
  }
  function message(s) {
    let body;
    if (s.game === "c4") body = "CONNECT FOUR. Human=1, you=2. Rows top to bottom:\n" + s.board.map(row => row.join(" ")).join("\n") + "\nColumns 1-7. Reply with [MOVE: N], one non-full column.";
    if (s.game === "ttt") body = "TIC TAC TOE. Human=1 (X), you=2 (O), empty=0. Fields 1-9, row-major:\n" + s.cells.join(" ") + "\nReply with [TTT: N], one empty field.";
    if (s.game === "sb") body = "BATTLESHIPS. Columns A-J, rows 1-10. Both fleets are hidden. Ships: 5,4,3,3,2 cells.\nYour hits: " + shotList(s.shots[2], 2) + "; misses: " + shotList(s.shots[2], 1) + "\nHuman hits: " + shotList(s.shots[1], 2) + "; misses: " + shotList(s.shots[1], 1) + "\nSunk human ships: " + s.fleets[1].filter(ship => ship.every(([r,c]) => s.shots[2][r][c] === 2)).length + "; sunk agent ships: " + s.fleets[2].filter(ship => ship.every(([r,c]) => s.shots[1][r][c] === 2)).length + "\nReply with [SHOT: C4], one untried coordinate. Turns alternate after every shot.";
    if (s.game === "db") {
      const free = [];
      for (const kind of ["H", "V"]) s.dots[kind.toLowerCase()].forEach((row, r) => row.forEach((v, c) => { if (!v) free.push(`${kind} ${r} ${c}`); }));
      body = "DOTS AND BOXES, 6 columns x 5 rows. Closing a box earns another turn. Human score: " + s.dots.scores[1] + "; your score: " + s.dots.scores[2] + ".\nFree edges (all others occupied): " + free.join(", ") + "\nH: row 0-5, column 0-5; V: row 0-4, column 0-6. Reply with [EDGE: H r c] or [EDGE: V r c], one free edge.";
    }
    return "[GAME] " + body + (s.over ? "\nGame over. Winner: " + (s.winner === 1 ? "human" : s.winner === 2 ? "you" : "draw") + ". Do not move." : s.turn === 2 ? "\nYour turn." : "\nHuman plays again. Do not move yet.");
  }
  async function send() {
    const current = state;
    current.error = false;
    try { await config.send(message(current)); }
    catch { if (state === current) { current.error = true; render(); } }
  }
  function move(value, player) {
    if (!state || state.over || state.placing || state.turn !== player) return false;
    const s = state;
    if (s.game === "c4") {
      const next = drop(s.board, value, player); if (!next) return false;
      s.board = next; s.winner = winningCells(next, player) ? player : 0;
      s.over = !!s.winner || next[0].every(Boolean); s.turn = 3 - player;
    }
    if (s.game === "ttt") {
      if (!Number.isInteger(value) || value < 0 || value > 8 || s.cells[value]) return false;
      s.cells[value] = player; s.winner = tttWinner(s.cells)?.who || 0;
      s.over = !!s.winner || s.cells.every(Boolean); s.turn = 3 - player;
    }
    if (s.game === "sb") {
      const result = shoot(s.fleets[3 - player], s.shots[player], value.r, value.c); if (!result) return false;
      s.shots[player] = result.shots; s.over = result.over; s.winner = s.over ? player : 0; s.turn = 3 - player;
      s.last = { player, coordinate: coord(value.r, value.c), hit: result.hit, sunk: result.sunk };
    }
    if (s.game === "db") {
      const result = setEdge(s.dots, value, player); if (!result) return false;
      s.dots = result.state; s.turn = s.dots.turn; s.over = result.over;
      if (s.over) s.winner = s.dots.scores[1] === s.dots.scores[2] ? 0 : s.dots.scores[1] > s.dots.scores[2] ? 1 : 2;
    }
    render();
    if (player === 1 || s.turn === 2 && !s.over) send();
    return true;
  }
  function render() {
    const panel = document.getElementById("game-panel");
    if (!panel || !state) return;
    const s = state, agent = config.agent();
    panel.replaceChildren(); panel.classList.add("open");
    const head = element("div", undefined, panel, "game-head");
    element("strong", title(s.game), head);
    button(head, t("games.restart"), () => start(s.game));
    button(head, t("games.close"), close);
    const status = s.over ? s.winner ? t("games.wins", { name: s.winner === 1 ? t("games.you") : agent }) : t("games.draw") : s.turn === 1 ? t("games.turn") : t("games.wait", { name: agent });
    element("p", status, panel, "game-status");
    if (s.game !== "sb") element("p", t(s.game === "c4" ? "games.legendDiscs" : "games.legend", { agent }), panel, "game-status");
    if (s.error) button(panel, t("games.retry"), send);
    const locked = s.over || s.turn !== 1;
    if (s.game === "c4") {
      const board = element("div", undefined, panel, "games-c4");
      for (let c = 0; c < 7; c++) {
        const col = button(board, "", () => move(c, 1), locked || !!s.board[0][c]);
        col.setAttribute("aria-label", t("games.column", { n: c + 1 }));
        const wins = s.winner ? winningCells(s.board, s.winner) : null;
        s.board.forEach((row, r) => {
          const cell = element("span", "", col, "game-piece" + (row[c] === 1 ? " human" : row[c] === 2 ? " agent" : "") + (wins?.some(([rr, cc]) => rr === r && cc === c) ? " win" : ""));
          cell.setAttribute("role", "img");
          cell.setAttribute("aria-label", t("games.field", { n: r * 7 + c + 1, mark: row[c] === 1 ? t("games.you") : row[c] === 2 ? agent : t("games.unknown") }));
        });
      }
    }
    if (s.game === "ttt") {
      const board = element("div", undefined, panel, "games-ttt");
      const wins = tttWinner(s.cells)?.line;
      s.cells.forEach((v, i) => { const b = button(board, v === 1 ? "✗" : v === 2 ? "○" : "", () => move(i, 1), locked || !!v, (v === 1 ? "human" : v === 2 ? "agent" : "") + (wins?.includes(i) ? " win" : "")); b.setAttribute("aria-label", t("games.field", { n: i + 1, mark: v === 1 ? "✗" : v === 2 ? "○" : "·" })); });
    }
    if (s.game === "db") {
      element("p", t("games.score", { human: s.dots.scores[1], agent: s.dots.scores[2] }), panel, "game-status");
      const board = element("div", undefined, panel, "games-dots");
      for (let r = 0; r <= 10; r++) for (let c = 0; c <= 12; c++) {
        if (!(r % 2) && !(c % 2)) element("span", "", board, "db-dot");
        else if (r % 2 && c % 2) {
          const owner = s.dots.owner[(r - 1) / 2][(c - 1) / 2];
          element("span", ["", "✗", "○"][owner], board, "db-box" + (owner === 1 ? " human" : owner === 2 ? " agent" : ""));
        } else {
          const kind = r % 2 ? "V" : "H", rr = Math.floor(r / 2), cc = Math.floor(c / 2), owner = s.dots[kind.toLowerCase()][rr][cc];
          const b = button(board, "", () => move({ kind, r: rr, c: cc }, 1), locked || !!owner, (kind === "H" ? "db-h" : "db-v") + (owner === 1 ? " human" : owner === 2 ? " agent" : ""));
          b.setAttribute("aria-label", t("games.edge", { kind, r: rr, c: cc }));
        }
      }
    }
    if (s.game === "sb") {
      if (s.placing) {
        element("p", t("games.place", { n: [5,4,3,3,2][s.fleets[1].length], direction: s.horizontal ? t("games.horizontal") : t("games.vertical") }), panel);
        button(panel, t("games.rotate"), () => { s.horizontal = !s.horizontal; render(); });
        button(panel, t("games.random"), () => { s.fleets[1] = randomFleet(); s.placing = false; render(); });
      }
      if (s.last) element("p", t("games.shot", { name: s.last.player === 1 ? t("games.you") : agent, coordinate: s.last.coordinate, result: s.last.hit ? t("games.hit") : t("games.miss"), sunk: s.last.sunk }), panel);
      const dual = element("div", undefined, panel, "games-fleets");
      for (const own of s.placing ? [true] : [false, true]) {
        const side = element("div", undefined, dual);
        element("p", own ? t("games.fleet") : t("games.water", { name: agent }), side);
        const board = element("div", undefined, side, "games-sea");
        element("span", "", board);
        for (const letter of "ABCDEFGHIJ") element("span", letter, board);
        for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
          if (c === 0) element("span", String(r + 1), board);
          const shot = s.shots[own ? 2 : 1][r][c], ship = own && s.fleets[1].some(cells => cells.some(([rr,cc]) => rr === r && cc === c));
          const b = button(board, shot === 2 ? "X" : shot === 1 ? "·" : ship ? "■" : "", () => {
            if (s.placing) { const next = placeShip(s.fleets[1], [5,4,3,3,2][s.fleets[1].length], r, c, s.horizontal); if (!next) return; s.fleets[1] = next; s.placing = next.length < 5; render(); }
            else move({ r, c }, 1);
          }, s.placing ? false : own || locked || !!shot, "sb-cell" + (shot === 2 ? " hit" : shot === 1 ? " miss" : ship ? " ship" : ""));
          b.setAttribute("aria-label", t("games.coordinate", { coordinate: coord(r,c), state: shot === 2 ? t("games.hit") : shot === 1 ? t("games.miss") : ship ? t("games.ship") : t("games.unknown") }));
          b.title = b.getAttribute("aria-label");
        }
      }
    }
  }
  function closeMenu() { menu?.remove(); menu = null; }
  root.AgentGames = {
    configure(value) { config = value; },
    close() { closeMenu(); close(); },
    toggleMenu() {
      if (!config || !config.enabled()) return;
      if (menu) { closeMenu(); return; }
      menu = element("div", undefined, document.body); menu.id = "game-menu";
      for (const game of ["c4", "sb", "ttt", "db"]) button(menu, title(game), () => { closeMenu(); start(game); });
    },
    handleAgentMessage(text, ts) {
      if (!state || !config.enabled() || ts && Date.parse(ts) < state.started) return false;
      const value = parseMove(state.game, text);
      return value !== null && move(value, 2);
    },
    isActive: () => !!state && !state.over
  };
  document.addEventListener("click", event => { if (menu && !menu.contains(event.target) && !event.target.closest("#games-btn")) closeMenu(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
})(typeof window === "undefined" ? globalThis : window);
