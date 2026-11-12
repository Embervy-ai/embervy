// Runs the app's chat, voice, terminal panel and settings.

(function () {
  "use strict";

  // Device preferences take precedence over installer defaults.
  const HOUSE_FEATURES = window.embervyHouseFeatures || {};

  const I18N = window.embervyI18n || {
    language: "en",
    t: (key) => key,
    formatTime: (ts) => new Date(ts).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
    formatNumber: (n) => Number(n).toLocaleString("en"),
  };
  const t = I18N.t;
  // Wait for the harness/menu capability before asking for Claude's sign-in.
  let claudeAuthEnabled = false;
  const gameText = (key, vars) => ({
    "games.c4": () => t("games.c4", vars),
    "games.sb": () => t("games.sb", vars),
    "games.ttt": () => t("games.ttt", vars),
    "games.db": () => t("games.db", vars),
    "games.restart": () => t("games.restart", vars),
    "games.close": () => t("games.close", vars),
    "games.you": () => t("games.you", vars),
    "games.wins": () => t("games.wins", vars),
    "games.draw": () => t("games.draw", vars),
    "games.turn": () => t("games.turn", vars),
    "games.wait": () => t("games.wait", vars),
    "games.legend": () => t("games.legend", vars),
    "games.legendDiscs": () => t("games.legendDiscs", vars),
    "games.retry": () => t("games.retry", vars),
    "games.column": () => t("games.column", vars),
    "games.field": () => t("games.field", vars),
    "games.score": () => t("games.score", vars),
    "games.edge": () => t("games.edge", vars),
    "games.place": () => t("games.place", vars),
    "games.horizontal": () => t("games.horizontal", vars),
    "games.vertical": () => t("games.vertical", vars),
    "games.rotate": () => t("games.rotate", vars),
    "games.random": () => t("games.random", vars),
    "games.shot": () => t("games.shot", vars),
    "games.hit": () => t("games.hit", vars),
    "games.miss": () => t("games.miss", vars),
    "games.fleet": () => t("games.fleet", vars),
    "games.water": () => t("games.water", vars),
    "games.coordinate": () => t("games.coordinate", vars),
    "games.ship": () => t("games.ship", vars),
    "games.unknown": () => t("games.unknown", vars)
  })[key]?.() || key;
  window.AgentGames?.configure({
    text: gameText,
    agent: () => document.querySelector("#header h1")?.textContent || "Embervy",
    enabled: () => featureEnabled("games"),
    send: async (text) => {
      const res = await fetch("/api/message", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error("Game send failed");
      const data = await res.json();
      if (data.ok === false) throw new Error("Game send rejected");
    }
  });
  document.getElementById("games-btn")?.addEventListener("click", () => window.AgentGames?.toggleMenu());

  // Message fields come from outside: validate them against the server's rules and escape text and attributes, also for stored history.
  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  const escapeAttr = escapeHtml;

  const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
  function safeMsgId(id) {
    const s = typeof id === "number" && Number.isFinite(id) ? String(id) : id;
    return typeof s === "string" && MESSAGE_ID_RE.test(s) ? s : "";
  }

  // Stored messages need these path formats to keep their media links working.
  const MEDIA_PATH_RE = /^\/api\/(?:images|memory-image|memory-video)\/[A-Za-z0-9._-]+$/;
  const PLAIN_URL_RE = /^[^\s"'<>\\`]+$/;
  function safeMediaUrl(url, allowRemote = false) {
    if (typeof url !== "string" || !PLAIN_URL_RE.test(url)) return "";
    if (MEDIA_PATH_RE.test(url)) return url.split("/").every((p) => p !== "." && p !== "..") ? url : "";
    try {
      const parsed = new URL(url);
      if (typeof location !== "undefined" && parsed.origin === location.origin && !parsed.search && !parsed.hash
          && MEDIA_PATH_RE.test(parsed.pathname)) return parsed.pathname;
      return allowRemote && parsed.protocol === "https:" ? url : "";
    } catch {
      return "";
    }
  }

  // "[Image]" and "[File: name]" are upload markers for the agent, never shown as text.
  function withMedia(content, text, imageUrl, originalName) {
    const url = safeMediaUrl(imageUrl, true);
    if (!url) return content;
    if (safeMediaUrl(url) && /\.(jpg|jpeg|png|gif|webp|svg|heic)$/i.test(url)) {
      return `<img src="${escapeAttr(url)}" class="chat-image" loading="lazy">` + (text !== "[Image]" ? content : "");
    }
    const fileName = originalName || String(text ?? "").replace(/^\[File: /, "").replace(/\]$/, "") || t("chat.fileFallback");
    const caption = originalName && text && text !== `[File: ${originalName}]` ? content : "";
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="file-link">${escapeHtml(fileName)}</a>` + caption;
  }

  function quoteHtml(meta) {
    if (!meta || !meta.snippet) return "";
    const who = meta.role === "email" ? t("chat.reply.mail") : meta.role === "assistant" ? t("chat.reply.them") : t("chat.reply.you");
    return `<div class="msg-quote" data-jump="${escapeAttr(safeMsgId(meta.id))}"><span class="reply-bar-who">${escapeHtml(who)}</span>${escapeHtml(meta.snippet)}</div>`;
  }

  function doctorCheckHtml(c) {
    const problem = c.status === "FAIL" || c.status === "WARN";
    const muted = problem && typeof c.muted_until === "string" && Date.parse(c.muted_until) > Date.now();
    const tag = c.status === "OK" ? "✓" : c.status === "WARN" ? "⚠" : c.status === "SKIP" ? "–" : "✗";
    const hasId = typeof c.id === "string" && c.id.length > 0 && c.id.length <= 200;
    let html = (hasId ? `<div class="doctor-check${muted ? " doctor-muted" : ""}">` : "") + `${tag} ${escapeHtml(c.label)}`;
    if (muted) {
      html += ` <small>${escapeHtml(t("doctor.mutedUntil", { time: I18N.formatTime(c.muted_until) }))}</small>`;
    } else {
      if (c.detail) html += ` <small>— ${escapeHtml(c.detail)}</small>`;
      if (problem && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 200) {
        html += ` <button type="button" class="doctor-seen" data-doctor-mute="${escapeAttr(c.id)}" title="${escapeAttr(t("doctor.seenTitle"))}">${escapeHtml(t("doctor.seen"))}</button>`;
      }
      if (c.fix && c.status !== "OK") html += `<br>&nbsp;&nbsp;<small>${escapeHtml(t("doctor.fix", { fix: c.fix }))}</small>`;
    }
    return html + (hasId ? "</div>" : "<br>");
  }

  function doctorReportHtml(r) {
    const s = r.summary || {};
    let html = `<strong>${escapeHtml(t("doctor.reportTitle", { result: r.result || "?" }))}</strong><br>`;
    html += `<small>${escapeHtml(t("doctor.summary", { pass: s.pass || 0, warn: s.warn || 0, fail: s.fail || 0 }))}</small><br><br>`;
    let lastGroup;
    for (const c of r.checks || []) {
      if (c.group !== lastGroup) {
        html += `<br><em>${escapeHtml(c.group)}</em><br>`;
        lastGroup = c.group;
      }
      html += doctorCheckHtml(c);
    }
    return html;
  }

  function appearanceTextColors(background) {
    const defaults = { text: "#2C2C2C", textLight: "#6B6560" };
    if (!/^#[0-9a-f]{6}$/i.test(background)) return defaults;
    const luminance = (hex) => {
      const channels = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const bg = luminance(background);
    const contrast = (hex) => {
      const fg = luminance(hex);
      return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    };
    const light = { text: "#ECEFF4", textLight: "#A9B1C0" };
    const chosen = contrast(defaults.text) >= contrast(light.text) ? defaults : light;
    // Midtones may need pure black/white; the best of these always exceeds 4.5.
    const text = contrast(chosen.text) >= 4.5 ? chosen.text
      : (bg > 0.179 ? "#000000" : "#FFFFFF");
    return { text, textLight: contrast(chosen.textLight) >= 4.5 ? chosen.textLight : text };
  }

  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");
  const hexChannels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function mixHex(from, to, t) {
    const b = hexChannels(to);
    return "#" + hexChannels(from).map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  function luminance(h) {
    const [r, g, b] = hexChannels(h).map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function readableOn(bg) {
    const dark = "#2C2C2C", light = "#ECEFF4";
    const best = contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light;
    if (contrastRatio(bg, best) >= 4.5) return best;
    return luminance(bg) > 0.179 ? "#000000" : "#FFFFFF";
  }
  function suggestLook(bg, own) {
    const text = readableOn(bg);
    const base = isHex(own) ? own : mixHex(bg, text, 0.5);
    let accent = base;
    for (let step = 1; contrastRatio(accent, bg) < 4.5 && step <= 10; step++) accent = mixHex(base, text, step / 10);
    return { text, accent, onAccent: readableOn(accent), border: mixHex(bg, text, 0.25) };
  }
  function healAppearance(stored) {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    if (stored.appearanceVersion === 1) return stored;
    if (isHex(stored.bgColor)) {
      const look = suggestLook(stored.bgColor, stored.userColor);
      const fields = { textColor: look.text, accentColor: look.accent, onAccentColor: look.onAccent, borderColor: look.border };
      for (const [key, value] of Object.entries(fields)) {
        if (isHex(stored[key]) && stored[key].toLowerCase() === value.toLowerCase()) delete stored[key];
      }
    }
    // Full saves include untouched defaults; retaining them would block changes to the installed theme.
    const oldDefaults = { bgMode: "color", bgColor: "#0B1228", bgPhoto: "", userColor: "#D4A948", userAlpha: 20, agentColor: "#5A91DC", agentAlpha: 18, titleText: "Embervy", titleFont: '"Snell Roundhand", "Savoye LET", "Segoe Script", "Brush Script MT", cursive', titleColor: "#7FB2F0" };
    if (Object.keys(oldDefaults).every((key) => Object.hasOwn(stored, key))) {
      for (const [key, value] of Object.entries(oldDefaults)) {
        const same = isHex(value) && isHex(stored[key]) ? stored[key].toLowerCase() === value.toLowerCase() : stored[key] === value;
        if (same) delete stored[key];
      }
    }
    stored.appearanceVersion = 1;
    return stored;
  }
  function cssColor(value, fallback, alpha = 100) {
    if (isHex(value)) return { color: value, alpha };
    const match = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
    return match ? { color: "#" + match.slice(1, 4).map((v) => (+v).toString(16).padStart(2, "0")).join(""), alpha: match[4] === undefined ? 100 : +match[4] * 100 } : { color: fallback, alpha };
  }

  // The stored photo is a data URL of several hundred kilobytes; as a blob:
  // address the style rule stays short.
  let photoBlob = { data: "", url: "" };
  function photoAddress(data) {
    if (photoBlob.data === data) return photoBlob.url;
    let url = data;
    try {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (match && typeof URL.createObjectURL === "function") {
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
      }
    } catch { url = data; }
    if (photoBlob.url.startsWith("blob:")) URL.revokeObjectURL(photoBlob.url);
    photoBlob = { data, url };
    return url;
  }

  const SHIPPED_THEME_COLOR = document.querySelector?.('meta[name="theme-color"]')?.getAttribute("content") || "";
  function applyAppearance() {
    let a, raw;
    try { raw = localStorage.getItem("embervy-appearance"); a = healAppearance(JSON.parse(raw || "{}")); }
    catch { a = {}; }
    if (raw && JSON.stringify(a) !== raw) {
      try { localStorage.setItem("embervy-appearance", JSON.stringify(a)); } catch {}
    }
    const root = document.documentElement.style;
    const valid = (v) => /^#[0-9a-f]{6}$/i.test(v || "");
    const rgba = (hex, pct) => {
      const h = String(hex || "").replace("#", "");
      if (h.length !== 6) return null;
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      return `rgba(${r}, ${g}, ${b}, ${(Number(pct||0)/100).toFixed(2)})`;
    };
    const themeColor = (value) => document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", value);
    for (const name of ["--bg", "--bg-chat", "--text", "--text-light", "--border", "--accent", "--accent-hover", "--on-accent", "--bg-user", "--bg-agent"]) root.removeProperty(name);
    const house = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
    const houseValue = (name) => house?.getPropertyValue(name).trim() || "";
    const houseBg = cssColor(houseValue("--bg"), "#F5F0EB").color;
    const houseUser = cssColor(houseValue("--bg-user"), "#E8E0D8");
    const houseAgent = cssColor(houseValue("--bg-agent"), "#FFFFFF");
    if (SHIPPED_THEME_COLOR) themeColor(SHIPPED_THEME_COLOR);
    const colorMode = a.bgMode !== "photo" && a.bgMode !== "default" && valid(a.bgColor);
    const photoMode = a.bgMode === "photo" && !!a.bgPhoto;
    if (colorMode || photoMode) {
      const bp = document.getElementById("bg-photo-style") || (() => {
        const el = document.createElement("style"); el.id = "bg-photo-style";
        document.head.appendChild(el); return el;
      })();
      if (colorMode) {
        document.body.style.setProperty("--_bgset", "1");
        bp.textContent = `body::before{content:"";position:fixed;inset:0;z-index:-1;background:${a.bgColor} !important;}`;
      } else {
        // contain, not cover: the whole image stays visible. The body turns transparent
        // because an opaque body paints over a z-index:-1 layer.
        bp.textContent = `body{background:transparent !important;}body::before{content:"";position:fixed;inset:0;z-index:-1;background:var(--bg) url("${photoAddress(a.bgPhoto)}") center / contain no-repeat !important;}`;
      }
      if (valid(a.bgColor)) {
        root.setProperty("--bg", a.bgColor);
        root.setProperty("--bg-chat", a.bgColor);
        themeColor(a.bgColor);
      }
      // A background choice must stay readable on inherited opaque bubbles too.
      if (!valid(a.textColor)) {
        const bubbleText = (color, alpha, base) => readableOn(mixHex(valid(a.bgColor) ? a.bgColor : houseBg, valid(color) ? color : base.color, (alpha ?? base.alpha) / 100));
        bp.textContent += `.message.user{color:${bubbleText(a.userColor, a.userAlpha, houseUser)};} .message.assistant,.message.email,.approval-card,.doctor-report,.typing,.emoji-picker{color:${bubbleText(a.agentColor, a.agentAlpha, houseAgent)};} .message .time,.voice-duration,.voice-transcript{color:inherit;}`;
      }
    } else {
      const old = document.getElementById("bg-photo-style");
      if (old) old.remove();
    }
    const background = (colorMode || photoMode) && valid(a.bgColor) ? a.bgColor : houseBg;
    const derived = (colorMode || (photoMode && valid(a.bgColor)) || valid(a.userColor))
      ? suggestLook(background, valid(a.userColor) ? a.userColor : houseUser.color) : {};
    const text = valid(a.textColor) ? a.textColor : derived.text;
    if (text) {
      root.setProperty("--text", text);
      root.setProperty("--text-light", valid(a.textColor) ? rgba(text, 72) : appearanceTextColors(background).textLight);
    }
    const accent = valid(a.accentColor) ? a.accentColor : derived.accent;
    if (accent) {
      root.setProperty("--accent", accent);
      root.setProperty("--accent-hover", rgba(accent, 85));
      root.setProperty("--on-accent", valid(a.onAccentColor) ? a.onAccentColor : readableOn(accent));
    } else if (valid(a.onAccentColor)) root.setProperty("--on-accent", a.onAccentColor);
    const border = valid(a.borderColor) ? a.borderColor : derived.border;
    if (border) root.setProperty("--border", border);
    if (valid(a.userColor) || a.userAlpha !== undefined) {
      root.setProperty("--bg-user", rgba(valid(a.userColor) ? a.userColor : houseUser.color, a.userAlpha ?? houseUser.alpha));
    }
    if (valid(a.agentColor) || a.agentAlpha !== undefined) {
      root.setProperty("--bg-agent", rgba(valid(a.agentColor) ? a.agentColor : houseAgent.color, a.agentAlpha ?? houseAgent.alpha));
    }
    const h1 = document.querySelector("#header h1");
    if (h1) {
      if (a.titleText) h1.textContent = a.titleText;
      if (a.titleFont) h1.style.fontFamily = a.titleFont;
      if (a.titleColor) h1.style.color = a.titleColor;
    }
  }
  applyAppearance();

  function featureEnabled(key) {
    try {
      const settings = JSON.parse(localStorage.getItem("embervy-appearance") || "null");
      return (settings?.features?.[key] ?? HOUSE_FEATURES[key]) !== false;
    } catch { return HOUSE_FEATURES[key] !== false; }
  }

  function terminalPanelEnabled() {
    return featureEnabled("terminal_panel");
  }
  if (!terminalPanelEnabled()) {
    document.getElementById("terminal-btn")?.setAttribute("hidden", "");
    document.getElementById("activity-dot")?.setAttribute("hidden", "");
    document.getElementById("activity-strip")?.setAttribute("hidden", "");
  }

  const activityDot = document.getElementById("activity-dot");
  const activityStrip = document.getElementById("activity-strip");
  const activityStripPrefix = document.getElementById("activity-strip-prefix");
  const activityStripTask = document.getElementById("activity-strip-task");
  const activityStripDuration = document.getElementById("activity-strip-duration");
  const activityStripTokens = document.getElementById("activity-strip-tokens");
  let activityStripSince = 0;
  let activityStripTimer = null;
  const activityLabels = {
    idle: t("activity.idle"),
    thinking: t("activity.thinking"),
    tool: t("activity.tool"),
    done: t("activity.done"),
    needs_input: t("activity.needsInput"),
  };
  const compactTokens = (n) => (n < 1000 ? I18N.formatNumber(n) : `${I18N.formatNumber(Math.round(n / 100) / 10)}k`);
  let activityWaiting = [];
  function sideProcessText() {
    if (!activityWaiting.length) return "";
    return t("activity.sideProcesses", { list: activityWaiting.map((p) => {
      const name = String(p.description || "").length > 26 ? `${String(p.description).slice(0, 25)}…` : String(p.description || "");
      if (typeof p.tokens === "number" && p.tokens > 0) return `${name} ↓ ${compactTokens(p.tokens)}`;
      const s = Math.max(0, Math.floor((Date.now() - (Date.parse(p.since) || Date.now())) / 1000));
      return `${name} ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}`;
    }).join("\n") });
  }
  function updateActivityDuration() {
    if (activityStripTask) {
      const side = sideProcessText();
      activityStripTask.textContent = side;
      activityStripTask.hidden = !side;
    }
    if (!activityStripDuration || !activityStripSince) return;
    const seconds = Math.max(0, Math.floor((Date.now() - activityStripSince) / 1000));
    activityStripDuration.textContent = t("activity.duration", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  }
  function renderActivity(state, data = {}) {
    if (!activityDot) return;
    const label = activityLabels[state] || activityLabels.idle;
    activityDot.className = `activity-${state}`;
    activityDot.title = label;
    activityDot.setAttribute("aria-label", label);
    if (!activityStrip) return;
    const active = terminalPanelEnabled() && (state === "thinking" || state === "tool");
    activityWaiting = terminalPanelEnabled() && Array.isArray(data.waitingTasks) ? data.waitingTasks : [];
    activityStrip.hidden = !active && !activityWaiting.length;
    clearInterval(activityStripTimer);
    activityStripTimer = null;
    if (!active && !activityWaiting.length) return;
    if (!active) {
      if (activityStripPrefix) activityStripPrefix.textContent = t("activity.waiting");
      activityStripSince = Date.parse(activityWaiting[0].since) || Date.now();
      activityStripTokens.hidden = true;
      updateActivityDuration();
      activityStripTimer = setInterval(updateActivityDuration, 1000);
      return;
    }
    activityStripSince = Date.parse(data.since) || Date.now();
    const doing = typeof data.stalledHead === "string"
      ? (data.stalledHead ? t("activity.stalled", { head: data.stalledHead }) : t("activity.stalledModel"))
      : (state === "tool" ? (data.task || activityLabels.tool) : activityLabels.thinking);
    const queued = Number(data.queued) || 0;
    if (activityStripPrefix) activityStripPrefix.textContent = `◉ ${doing}`
      + (queued ? ` · ${queued === 1 ? t("activity.queuedOne") : t("activity.queuedMany", { count: queued })}` : "");
    if (typeof data.tokens === "number" && Number.isFinite(data.tokens)) {
      activityStripTokens.hidden = false;
      const out = Number(data.turnOut) || 0, helperOut = Number(data.helperOut) || 0;
      activityStripTokens.textContent = t("activity.tokens", { tokens: compactTokens(data.tokens) })
        + (out ? ` · ${t("activity.turnOut", { tokens: (data.turnOutEstimated ? "≈" : "") + compactTokens(out) })}` : "")
        + (helperOut ? ` · ${t("activity.helperOut", { tokens: compactTokens(helperOut) })}` : "");
    } else activityStripTokens.hidden = true;
    updateActivityDuration();
    activityStripTimer = setInterval(updateActivityDuration, 1000);
  }
  async function pollActivity() {
    if (!activityDot || !terminalPanelEnabled()) {
      if (activityDot) activityDot.hidden = true;
      if (activityStrip) activityStrip.hidden = true;
      return;
    }
    activityDot.hidden = false;
    try {
      const response = await fetch("/api/activity", { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!activityLabels[data.state]) throw new Error("unknown activity state");
      renderActivity(data.state, data);
      renderWindowPct(data.percent);
    } catch { renderActivity("idle"); }
  }
  const windowPctEl = document.getElementById("window-pct");
  function renderWindowPct(percent) {
    if (!windowPctEl) return;
    if (typeof percent !== "number" || !Number.isFinite(percent)) { windowPctEl.hidden = true; return; }
    windowPctEl.textContent = `${Math.max(0, Math.round(percent))}%`;
    windowPctEl.hidden = false;
    windowPctEl.classList.toggle("pct-warn", percent >= 85);
  }
  if (activityDot) {
    pollActivity();
    setInterval(pollActivity, 5000);
  }

  // The notepad stays on this device: it is not part of the chat history.
  (function setupNotes() {
    const notesBtn = document.getElementById("notes-btn");
    const overlay = document.getElementById("notes-overlay");
    const closeBtn = document.getElementById("notes-close-btn");
    const saveBtn = document.getElementById("notes-save-btn");
    const editor = document.getElementById("notes-textarea");
    const savedIndicator = document.getElementById("notes-saved-indicator");
    const fontSizeSelect = document.getElementById("notes-font-size");
    if (!notesBtn || !overlay || !editor) return;

    const STORAGE_KEY = "embervy-notes-html";
    let saveTimer = null;

    editor.innerHTML = localStorage.getItem(STORAGE_KEY) || "";

    function flashSaved() {
      savedIndicator.classList.add("visible");
      clearTimeout(savedIndicator._hideTimer);
      savedIndicator._hideTimer = setTimeout(() => savedIndicator.classList.remove("visible"), 1200);
    }

    function autosave() {
      localStorage.setItem(STORAGE_KEY, editor.innerHTML);
    }

    editor.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(autosave, 400);
    });

    notesBtn.addEventListener("click", () => {
      overlay.hidden = false;
      editor.focus();
    });
    // Closing can beat the autosave debounce; save without clearing the draft.
    function closeOverlay() {
      clearTimeout(saveTimer);
      autosave();
      overlay.hidden = true;
    }
    closeBtn.addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeOverlay();
    });

    // No filename prompt: window.prompt() uses up the click's user activation on
    // iOS Safari, and navigator.share() then silently falls back to another sheet.
    async function doSave() {
      if (!editor.innerText.trim()) return;
      try {
        // Dashes in the date, so iOS does not take the year for a file extension.
        const today = new Date();
        const dateStr = `${today.getDate()}-${today.getMonth() + 1}-${today.getFullYear()}`;
        const filename = `${t("notes.fileName", { date: dateStr })}.txt`;
        const snapshot = editor.innerHTML;
        const file = new File([editor.innerText], filename, { type: "text/plain" });
        clearTimeout(saveTimer);
        autosave();
        // The draft goes only when its exact snapshot left the app; edits made meanwhile stay.
        const clearIfUnchanged = () => {
          if (editor.innerHTML === snapshot) {
            clearTimeout(saveTimer);
            localStorage.removeItem(STORAGE_KEY);
            editor.innerHTML = "";
          } else {
            autosave();
          }
          flashSaved();
        };

        // A closed writable or a completed share confirms the handoff; a plain download does not.
        if (typeof window.showSaveFilePicker === "function") {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: filename });
            const writable = await handle.createWritable();
            await writable.write(file);
            await writable.close();
            clearIfUnchanged();
          } catch (err) {
            if (err?.name !== "AbortError") window.alert?.(t("files.saveFailed"));
          }
          return;
        }
        let saved = false;
        const ios = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        if (ios && typeof navigator.share === "function") {
          try {
            await navigator.share({ files: [file] });
            saved = true;
          } catch (err) {
            if (err?.name === "AbortError") return; // user cancelled — keep the note
          }
        }
        if (!saved) {
          const url = URL.createObjectURL(file);
          const a = document.createElement("a");
          try {
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
          } finally {
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          }
        }
        if (saved) clearIfUnchanged();
        else autosave();
      } catch {
        window.alert?.(t("files.saveFailed"));
      }
    }
    saveBtn.addEventListener("click", doSave);

    document.querySelectorAll(".notes-toolbar button[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        editor.focus();
        document.execCommand(btn.dataset.cmd, false, null);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(autosave, 400);
      });
    });
    if (fontSizeSelect) {
      fontSizeSelect.addEventListener("change", () => {
        editor.focus();
        document.execCommand("fontSize", false, fontSizeSelect.value);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(autosave, 400);
      });
    }
  })();

  // A missing switch counts as on, so nothing disappears until someone turns it off.
  function applyFeatureToggles() {
    const hide = (id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    };
    if (!featureEnabled("doctor")) hide("doctor-btn");
    if (!featureEnabled("voice")) hide("mic-btn");
    const gamesButton = document.getElementById("games-btn");
    if (gamesButton) gamesButton.style.display = featureEnabled("games") ? "" : "none";
    if (!featureEnabled("games")) window.AgentGames?.close();
    if (!featureEnabled("notes")) hide("notes-btn");

  }
  applyFeatureToggles();
  window.addEventListener("storage", event => {
    if (event.key === "embervy-appearance" || event.key === null) applyFeatureToggles();
  });

  const PRODUCT_BUILD = true;
  function showSettingsGear() {
    try {
      const flag = localStorage.getItem("feature_settings_gear");
      if (flag === "1" || flag === "true") return true;
      if (flag === "0" || flag === "false") return false;
      return PRODUCT_BUILD;
    } catch { return PRODUCT_BUILD; }
  }
  (function titleResetEgg() {
    const h1 = document.querySelector("#header h1");
    if (!h1) return;
    let taps = 0, timer = null;
    h1.style.cursor = "pointer";
    h1.addEventListener("click", () => {
      taps++;
      clearTimeout(timer);
      timer = setTimeout(() => { taps = 0; }, 700);
      if (taps >= 3) {
        taps = 0;
        try {
          localStorage.removeItem("embervy-appearance");
          localStorage.removeItem("feature_settings_gear");
        } catch {}
        location.reload();
      }
    });
  })();

  if (showSettingsGear()) {
    const header = document.getElementById("header");
    if (header && !document.getElementById("settings-btn")) {
      const a = document.createElement("a");
      a.id = "settings-btn";
      a.href = "/settings.html";
      a.setAttribute("aria-label", t("header.settings"));
      a.title = t("header.settings");
      a.style.cssText = "color:var(--text-light);display:inline-flex;align-items:center;padding:4px;";
      a.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      header.appendChild(a);
    }
  }

  const messagesEl = document.getElementById("messages");
  messagesEl.addEventListener("click", (ev) => {
    const quote = ev.target instanceof Element ? ev.target.closest(".msg-quote[data-jump]") : null;
    if (quote && quote.dataset.jump) window.jumpToMessage(quote.dataset.jump);
  });
  messagesEl.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest(".copybox-btn") : null;
    if (!btn) return;
    const text = btn.parentElement?.querySelector("pre")?.innerText ?? "";
    const done = (ok) => {
      btn.textContent = ok ? t("chat.copybox.copied") : t("chat.copybox.failed");
      btn.classList.toggle("done", ok);
      setTimeout(() => { btn.textContent = t("chat.copybox.copy"); btn.classList.remove("done"); }, 1600);
    };
    // Older browsers and some installed web apps have no clipboard API: copy through a hidden field.
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(area); area.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      area.remove(); done(ok);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  });

  // Tapping a chat image opens it full screen with a save button: an installed
  // web app offers no "Save" on long press.
  async function downloadImage(src) {
    const base = (src.split("/").pop() || "image").split("?")[0];
    const name = base.includes(".") ? base : `${base}.jpg`;
    try {
      const res = await fetch(src, { credentials: "include" });
      if (!res.ok) throw new Error("Image fetch failed");
      const blob = await res.blob();
      const file = new File([blob], name, { type: blob.type || "image/jpeg" });
      await saveMediaFile(file);
    } catch {
      window.alert(t("files.saveFailed"));
    }
  }

  function lightboxImages() {
    return Array.from(messagesEl.querySelectorAll("img.chat-image, a.file-chip, a.file-link"))
      .map((element) => ({ element, src: element.tagName === "IMG" ? element.src
        : (/\.(jpg|jpeg|png|gif|webp|svg|heic)([?#]|$)/i.test(element.href) ? element.href : "") }))
      .filter((image) => image.src);
  }

  function openLightbox(src, origin) {
    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    const img = document.createElement("img");
    img.className = "lightbox-image";
    img.src = src;
    const images = lightboxImages();
    // Keep repeated images in their message positions, including the one tapped.
    let index = origin ? images.findIndex((image) => image.element === origin) : images.findIndex((image) => image.src === src);
    if (index < 0) { images.splice(0, images.length, { src }); index = 0; }
    terminalTouchX = terminalTouchY = null;
    const counter = document.createElement("div");
    counter.className = "lightbox-counter";
    counter.setAttribute("aria-live", "polite");
    const prevBtn = document.createElement("button");
    const nextBtn = document.createElement("button");
    prevBtn.type = nextBtn.type = "button";
    prevBtn.className = "lightbox-nav lightbox-prev";
    nextBtn.className = "lightbox-nav lightbox-next";
    prevBtn.textContent = "▲";
    nextBtn.textContent = "▼";
    prevBtn.title = t("lightbox.previous");
    nextBtn.title = t("lightbox.next");
    prevBtn.setAttribute("aria-label", t("lightbox.previous"));
    nextBtn.setAttribute("aria-label", t("lightbox.next"));
    function refreshNav() {
      prevBtn.hidden = nextBtn.hidden = counter.hidden = images.length < 2;
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === images.length - 1;
      counter.textContent = images.length > 1 ? t("lightbox.counter", { current: index + 1, total: images.length }) : "";
    }
    function show(next) {
      if (next < 0 || next >= images.length || next === index) return;
      reset();
      index = next;
      src = images[index].src;
      img.src = src;
      refreshNav();
    }
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); show(index - 1); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); show(index + 1); });
    refreshNav();

    let scale = 1, tx = 0, ty = 0;
    let pinch = null, drag = null, lastTap = null;
    let multiTouch = false, suppressClick = false;
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
    function clamp() {
      const maxX = Math.max(0, (img.clientWidth * scale - overlay.clientWidth) / 2 + 24);
      const maxY = Math.max(0, (img.clientHeight * scale - overlay.clientHeight) / 2 + 24);
      tx = scale === 1 ? 0 : Math.min(maxX, Math.max(-maxX, tx));
      ty = scale === 1 ? 0 : Math.min(maxY, Math.max(-maxY, ty));
    }
    function reset() {
      scale = 1; tx = ty = 0;
      pinch = drag = lastTap = null;
      multiTouch = false;
      apply();
    }
    const distance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    img.addEventListener("load", reset);
    overlay.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (e.target.closest("button")) return;
      if (e.touches.length >= 2) {
        multiTouch = suppressClick = true;
        lastTap = drag = null;
        pinch = { distance: Math.max(1, distance(e.touches)), scale };
      } else if (e.touches.length === 1 && !multiTouch) {
        const touch = e.touches[0];
        suppressClick = false;
        drag = { x: touch.clientX, y: touch.clientY, tx, ty, zoomed: scale > 1, moved: false };
      }
    }, { passive: true });
    overlay.addEventListener("touchmove", (e) => {
      e.stopPropagation();
      if (pinch && e.touches.length >= 2) {
        e.preventDefault();
        scale = Math.min(6, Math.max(1, pinch.scale * distance(e.touches) / pinch.distance));
        clamp(); apply();
      } else if (drag && e.touches.length === 1) {
        const dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
        if (Math.hypot(dx, dy) >= 10) { drag.moved = true; suppressClick = true; lastTap = null; }
        if (drag.zoomed) {
          e.preventDefault();
          tx = drag.tx + dx; ty = drag.ty + dy;
          clamp(); apply();
        }
      }
    }, { passive: false });
    overlay.addEventListener("touchend", (e) => {
      e.stopPropagation();
      // A remaining finger after a pinch must not become a tap or a page swipe.
      if (multiTouch) {
        pinch = null;
        if (!e.touches.length) { multiTouch = false; if (scale < 1.05) reset(); }
        return;
      }
      const touch = e.changedTouches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x, dy = touch.clientY - drag.y;
      const moved = drag.moved || Math.hypot(dx, dy) >= 10;
      if (!moved && e.target === img) {
        const now = Date.now();
        if (lastTap && now - lastTap.time < 320 && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 32) {
          if (scale > 1) reset();
          else { scale = 2.5; clamp(); apply(); }
          lastTap = null;
          suppressClick = true;
        } else lastTap = { time: now, x: touch.clientX, y: touch.clientY };
      } else if (moved) {
        suppressClick = true;
        lastTap = null;
        if (!drag.zoomed && scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
      }
      drag = null;
    }, { passive: true });
    overlay.addEventListener("touchcancel", (e) => {
      e.stopPropagation();
      pinch = drag = lastTap = null;
      multiTouch = false;
      suppressClick = true;
    }, { passive: true });
    apply();
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "lightbox-close";
    closeBtn.textContent = "×";
    closeBtn.title = t("lightbox.close");
    closeBtn.setAttribute("aria-label", t("lightbox.close"));
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "lightbox-download";
    saveBtn.title = t("lightbox.save");
    saveBtn.setAttribute("aria-label", t("lightbox.save"));
    saveBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
    function close() {
      reset();
      terminalTouchX = terminalTouchY = null;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        show(index + (e.key === "ArrowRight" ? 1 : -1));
      }
    }
    closeBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadImage(src); });
    overlay.addEventListener("click", (e) => {
      if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    overlay.append(img, counter, prevBtn, nextBtn, closeBtn, saveBtn);
    document.body.appendChild(overlay);
  }

  // A file in the chat goes to the share sheet or a download. Opened as a link,
  // an installed app on iOS shows it in its own window with no way back.
  const FILE_TYPES = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf", csv: "text/csv", txt: "text/plain", md: "text/markdown",
  };
  async function saveMediaFile(file) {
    // Touch Macs identify iPadOS; its share sheet keeps installed apps navigable.
    const ios = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && typeof navigator.share === "function") {
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    try {
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  async function shareFile(href, name) {
    try {
      const res = await fetch(href, { credentials: "include" });
      if (!res.ok) throw new Error("File fetch failed");
      const blob = await res.blob();
      const ext = (name.split(".").pop() || "").toLowerCase();
      const file = new File([blob], name, { type: FILE_TYPES[ext] || "application/octet-stream" });
      await saveMediaFile(file);
    } catch {
      window.alert(t("files.saveFailed"));
    }
  }

  messagesEl.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const img = target ? target.closest("img.chat-image") : null;
    if (img && img.src) { openLightbox(img.src, img); return; }
    const link = target ? target.closest("a.file-link") : null;
    if (!link) return;
    ev.preventDefault();
    const name = (link.textContent || "").trim() || (link.getAttribute("href") || "").split("/").pop() || "file";
    shareFile(link.href, name).catch((err) => console.error("file share failed:", err));
  });
  const inputEl = document.getElementById("input");
  // Persist drafts because navigating to settings reloads the page.
  const DRAFT_KEY = "embervy-draft";
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft && !inputEl.value) inputEl.value = draft;
  } catch {}
  inputEl.addEventListener("input", () => {
    try {
      if (inputEl.value) localStorage.setItem(DRAFT_KEY, inputEl.value);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {}
  });
  const sendBtn = document.getElementById("send-btn");
  const imageBtn = document.getElementById("image-btn");
  const imageInput = document.getElementById("image-input");
  const micBtn = document.getElementById("mic-btn");

  let ws = null;
  let reconnectTimer = null;
  let messageIds = new Set();
  let lastSeenTs = null;
  const workingEl = document.getElementById("agent-working");
  async function pollAgentActivity() {
    try {
      const r = await fetch("/api/activity", { credentials: "include" });
      const a = await r.json();
      if (workingEl) workingEl.hidden = !(a.state === "thinking" || a.state === "tool");
    } catch { if (workingEl) workingEl.hidden = true; }
  }
  setInterval(pollAgentActivity, 15000);
  pollAgentActivity();

  // The result goes into innerHTML. Code is taken out first and never read as
  // Markdown again, and every generated tag with attributes is parked behind a
  // placeholder, so no later rule can write into it.
  function renderMarkdown(text) {
    const parked = [];
    // \u0000 is stripped from the input below, so only this renderer makes placeholders.
    const PLACEHOLDER = /\u0000(\d+)\u0000/g;
    const park = (html, source, block = false) => `\u0000${parked.push({ html, source, block }) - 1}\u0000`;
    const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const unescapeText = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const restoreSource = (s) => String(s).replace(PLACEHOLDER, (_m, n) => parked[n].source);
    const sourceOf = (s) => restoreSource(unescapeText(s));
    const attr = (raw) => escapeText(raw).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    // Only http(s):, mailto: and relative URLs; anything with quotes, whitespace or angle brackets is refused.
    function safeUrl(u) {
      const v = String(u).trim();
      if (/["'<>\s\\]/.test(v) || v.startsWith("//")) return "#";
      if (/^https?:\/\//i.test(v)) return v;
      if (/^mailto:/i.test(v)) return v;
      if (v.startsWith("/")) return v;
      return "#";
    }

    let html = String(text ?? "").replace(/\u0000/g, "");
    const copyLabel = typeof t === "function" ? t("chat.copybox.copy") : "Copy";

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, _lang, code) =>
      park(`<div class="copybox"><button type="button" class="copybox-btn" aria-label="${attr(copyLabel)}">${escapeText(copyLabel)}</button><pre><code>${escapeText(restoreSource(code.trim()))}</code></pre></div>`, m, true));
    html = html.replace(/`([^`]+)`/g, (m, code) =>
      park(`<code>${escapeText(restoreSource(code))}</code>`, restoreSource(m)));

    html = escapeText(html);

    // Worker images go through the authenticated same-origin proxy, so the browser never needs the worker's token.
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
      let src = safeUrl(sourceOf(url));
      try {
        const parsed = new URL(src, location.origin);
        const match = parsed.pathname.match(/^\/images\/(\d+)$/);
        if (match && parsed.origin !== location.origin) src = `/api/memory-image/${match[1]}`;
      } catch {}
      const label = sourceOf(alt);
      let local = false;
      try { local = src !== "#" && new URL(src, location.origin).origin === location.origin; } catch {}
      return park(local
        ? `<img src="${attr(src)}" alt="${attr(label)}" class="chat-image" loading="lazy">`
        : `<a href="${attr(src)}" target="_blank" rel="noopener noreferrer">${escapeText(label || sourceOf(url))}</a>`, sourceOf(m));
    });

    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
      `${park(`<a href="${attr(safeUrl(sourceOf(url)))}" target="_blank" rel="noopener noreferrer">`, "")}${label}</a>`);

    // Bare addresses become links too: a phone app gives no way to open an address
    // that is only text. Closing punctuation is not part of the address.
    let insideLink = false;
    html = html.replace(/\u0000(\d+)\u0000|<\/a>|https?:\/\/[^\s<\u0000]+/g, (m, n) => {
      if (n !== undefined) { if (parked[n].html.startsWith("<a ")) insideLink = true; return m; }
      if (m === "</a>") { insideLink = false; return m; }
      if (insideLink) return m;
      const raw = sourceOf(m);
      let address = raw.replace(/[.,;:!?*'"]+$/, "");
      if (address.endsWith(")") && !address.includes("(")) address = address.replace(/\)+$/, "");
      const href = safeUrl(address);
      if (href === "#") return m;
      return park(`<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${escapeText(address)}</a>`, address) + escapeText(raw.slice(address.length));
    });

    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    html = html
      .split(/\n\n+/)
      .map((p) => {
        p = p.trim();
        if (!p) return "";
        const first = /^\u0000(\d+)\u0000/.exec(p);
        if (first && parked[first[1]].block) return p;
        return `<p>${p.replace(/\n/g, "<br>")}</p>`;
      })
      .filter(Boolean)
      .join("");

    // Restore once so generated HTML is never parsed as Markdown or as another placeholder.
    return html.replace(PLACEHOLDER, (_m, n) => parked[n].html);
  }

  const approvalStates = new Map();
  let houseQuestionVersion = 0;
  let houseQuestionBusy = false;
  function renderHouseQuestionCard(question, submitted) {
    const actions = question.readonly === true ? "" : question.enter === true && question.options.length === 0
      ? `<button type="button" data-house-enter="true"${submitted ? " disabled" : ""}>${escapeHtml(t("houseQuestion.continue"))}</button>`
      : question.options.map(option => `<button type="button" data-house-number="${option.number}"${submitted ? " disabled" : ""}>${escapeHtml(option.label)}</button>`).join("");
    return `<div class="approval-card house-question-card" data-house-question="${escapeAttr(question.id)}">` +
      `<div class="approval-head">${escapeHtml(t("houseQuestion.heading"))}</div>` +
      `<pre class="approval-detail">${escapeHtml(question.text)}</pre>` +
      (question.readonly === true ? "" : `<div class="approval-title">${escapeHtml(t("houseQuestion.terminal"))}</div>`) +
      `<div class="approval-actions">${actions}</div>` +
      `<div class="approval-status" role="status">${escapeHtml(question.readonly === true ? t("houseQuestion.waiting") : submitted ? t("houseQuestion.submitted") : t("houseQuestion.pending"))}</div></div>`;
  }
  function updateHouseQuestion(question, submitted) {
    const card = messagesEl.querySelector("[data-house-question]");
    if (!question) { if (card) card.remove(); return; }
    const html = renderHouseQuestionCard(question, submitted || houseQuestionBusy);
    if (card) card.outerHTML = html;
    else {
      messagesEl.insertAdjacentHTML("beforeend", html);
      scrollToBottom();
    }
  }
  async function refreshHouseQuestion() {
    const version = ++houseQuestionVersion;
    try {
      const res = await fetch("/api/house-question", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (version === houseQuestionVersion) updateHouseQuestion(data.question, data.submitted);
    } catch {}
  }
  messagesEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-house-number], button[data-house-enter]");
    if (!button || button.disabled || houseQuestionBusy) return;
    const card = button.closest("[data-house-question]");
    if (!card) return;
    houseQuestionBusy = true;
    ++houseQuestionVersion;
    card.querySelectorAll("button").forEach(item => { item.disabled = true; });
    try {
      const res = await fetch("/api/house-question/answer", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(button.dataset.houseEnter === "true"
          ? { id: card.dataset.houseQuestion, enter: true }
          : { id: card.dataset.houseQuestion, number: Number(button.dataset.houseNumber) })
      });
      if (!res.ok && res.status !== 409) throw new Error();
      houseQuestionBusy = false;
      await refreshHouseQuestion();
    } catch {
      card.querySelector(".approval-status").textContent = t("houseQuestion.error");
      card.querySelectorAll("button").forEach(item => { item.disabled = false; });
    } finally { houseQuestionBusy = false; }
  });
  setInterval(() => { if (document.visibilityState === "visible") refreshHouseQuestion(); }, 5000);

  function updateApproval(id, status) {
    if (!["pending", "allow", "deny", "expired"].includes(status)) return;
    if (approvalStates.has(id) && approvalStates.get(id) !== "pending") status = approvalStates.get(id);
    approvalStates.set(id, status);
    const labels = { pending: t("approval.pending"), allow: t("approval.allowed"), deny: t("approval.denied"), expired: t("approval.expired") };
    document.querySelectorAll(".approval-card").forEach(card => {
      if (card.dataset.approval !== id) return;
      card.querySelector(".approval-status").textContent = labels[status];
      if (status !== "pending") card.querySelector(".approval-actions")?.remove();
    });
  }
  async function refreshApproval(id) {
    try {
      const res = await fetch(`/api/approval/${encodeURIComponent(id)}`);
      if (res.ok) updateApproval(id, (await res.json()).status);
    } catch {}
  }
  function refreshOpenApprovals() {
    refreshHouseQuestion();
    document.querySelectorAll(".approval-card:not([data-house-question])").forEach(card => {
      if (card.dataset.email) refreshMailApproval(card.dataset.email);
      else if (card.querySelector(".approval-actions")) refreshApproval(card.dataset.approval);
    });
  }
  function renderApprovalCard(id, title, detail) {
    return `<div class="approval-card" data-approval="${escapeAttr(id)}"><div class="approval-head">🔒 ${escapeHtml(t("approval.heading"))}</div>` +
      `<div class="approval-title">${escapeHtml(title)}</div>` +
      (detail ? `<pre class="approval-detail">${escapeHtml(detail)}</pre>` : "") +
      `<div class="approval-actions"><button type="button" class="approval-allow" data-decision="allow">${escapeHtml(t("approval.allow"))}</button>` +
      `<button type="button" class="approval-deny" data-decision="deny">${escapeHtml(t("approval.deny"))}</button></div>` +
      `<div class="approval-status" role="status">${escapeHtml(t("approval.pending"))}</div></div>`;
  }
  function mailApprovalLabel(status) {
    if (status === "pending_approval") return t("approval.pending");
    if (["ready", "sending", "sent"].includes(status)) return t("approval.allowed");
    if (status === "discarded") return t("approval.denied");
    if (status === "failed") return t("email.cardFailed");
    return t("email.cardUnknown");
  }
  function mailApprovalActions() {
    return `<div class="approval-actions"><button type="button" class="approval-allow" data-mail-action="send">${escapeHtml(t("approval.allow"))}</button>` +
      `<button type="button" class="approval-deny" data-mail-action="discard">${escapeHtml(t("approval.deny"))}</button></div>`;
  }
  function renderMailApprovalCard(meta) {
    const status = meta.email_status || "unknown";
    return `<div class="approval-card" data-email="${escapeAttr(meta.email_id)}" data-email-status="${escapeAttr(status)}">` +
      `<div class="approval-head">🔒 ${escapeHtml(t("approval.heading"))}</div>` +
      `<div class="approval-title">${escapeHtml(t("email.cardTitle"))}</div>` +
      `<pre class="approval-detail">${escapeHtml(meta.email_detail || "")}</pre>` +
      (status === "pending_approval" && meta.email_detail ? mailApprovalActions() : "") +
      `<div class="approval-status" role="status">${escapeHtml(mailApprovalLabel(status))}</div></div>`;
  }
  const mailApprovalVersions = new Map();
  const mailApprovalBusy = new Set();
  function mailApprovalCards(id) {
    return [...document.querySelectorAll(".approval-card[data-email]")].filter(card => card.dataset.email === id);
  }
  function updateMailApproval(id, status) {
    mailApprovalVersions.set(id, (mailApprovalVersions.get(id) || 0) + 1);
    mailApprovalCards(id).forEach(card => {
      card.dataset.emailStatus = status;
      const line = card.querySelector(".approval-status");
      line.textContent = mailApprovalLabel(status);
      if (status !== "pending_approval") card.querySelector(".approval-actions")?.remove();
      else if (!card.querySelector(".approval-actions") && card.querySelector(".approval-detail").textContent) {
        line.insertAdjacentHTML("beforebegin", mailApprovalActions());
      }
      card.querySelectorAll("button").forEach(button => { button.disabled = mailApprovalBusy.has(id); });
    });
  }
  async function refreshMailApproval(id) {
    const version = (mailApprovalVersions.get(id) || 0) + 1;
    mailApprovalVersions.set(id, version);
    try {
      const res = await fetch(`/api/send-email/${encodeURIComponent(id)}/status`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      // A late read must not undo a newer decision or delivery event.
      if (mailApprovalVersions.get(id) === version) updateMailApproval(id, data.status);
    } catch {}
  }
  messagesEl.addEventListener("click", async (event) => {
    const button = event.target.closest(".approval-card button[data-mail-action]");
    if (!button || button.disabled) return;
    const card = button.closest(".approval-card");
    const id = card.dataset.email;
    if (mailApprovalBusy.has(id)) return;
    mailApprovalBusy.add(id);
    const version = (mailApprovalVersions.get(id) || 0) + 1;
    mailApprovalVersions.set(id, version);
    mailApprovalCards(id).forEach(item => item.querySelectorAll("button").forEach(btn => { btn.disabled = true; }));
    try {
      const res = await fetch("/api/send-email/approve", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: button.dataset.mailAction })
      });
      const data = await res.json();
      if (!res.ok && res.status !== 409 && res.status !== 404) throw new Error("approval failed");
      if (typeof data.status !== "string") throw new Error("missing mail state");
      if (mailApprovalVersions.get(id) === version) updateMailApproval(id, data.status);
      else await refreshMailApproval(id);
    } catch {
      mailApprovalCards(id).forEach(item => {
        if (item.querySelector(".approval-actions")) item.querySelector(".approval-status").textContent = t("approval.error");
      });
    } finally {
      mailApprovalBusy.delete(id);
      mailApprovalCards(id).forEach(item => item.querySelectorAll("button").forEach(btn => { btn.disabled = false; }));
    }
  });
  messagesEl.addEventListener("click", async (event) => {
    const button = event.target.closest(".approval-card button[data-decision]");
    if (!button) return;
    const card = button.closest(".approval-card");
    const buttons = card.querySelectorAll("button");
    buttons.forEach(btn => { btn.disabled = true; });
    try {
      const res = await fetch(`/api/approval/${encodeURIComponent(card.dataset.approval)}/decide`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: button.dataset.decision })
      });
      if (!res.ok) throw new Error("approval failed");
      updateApproval(card.dataset.approval, (await res.json()).status);
    } catch {
      if (card.querySelector(".approval-actions")) card.querySelector(".approval-status").textContent = t("approval.error");
    } finally { buttons.forEach(btn => { btn.disabled = false; }); }
  });

  function addMessage(role, text, ts, id, imageUrl, audioUrl, duration, replyMeta, approvalMeta) {
    if (approvalMeta?.source === "email") role = "email";
    if (id && messageIds.has(id)) return;
    if (id) messageIds.add(id);
    if (ts && (!lastSeenTs || ts > lastSeenTs)) lastSeenTs = ts;
    if (role !== "email" && !["approval", "email-approval"].includes(approvalMeta?.source)) {
      if (typeof text === "string" && text.startsWith("[GAME]")) return;
      if (role === "assistant") window.AgentGames?.handleAgentMessage(text, ts);
    }

    const audio = role === "email" ? "" : safeMediaUrl(audioUrl);
    if (audio) {
      return addVoiceMessage(role, text, ts, id, audio, duration, replyMeta);
    }

    if (role === "assistant") { showTyping(false); if (workingEl) workingEl.hidden = true; }

    const div = document.createElement("div");
    div.className = `message ${role}`;

    let content = role === "assistant" || role === "user" ? renderMarkdown(text) : escapeHtml(text).replace(/\n/g, "<br>");
    const approvalId = approvalMeta?.source === "approval" && typeof approvalMeta.approval_id === "string" ? approvalMeta.approval_id : null;
    if (approvalId) content = renderApprovalCard(approvalId, text, approvalMeta.detail || "");
    const emailId = approvalMeta?.source === "email-approval" && typeof approvalMeta.email_id === "string" ? approvalMeta.email_id : null;
    if (emailId) content = renderMailApprovalCard(approvalMeta);
    const time = ts ? formatTime(ts) : "";

    content = withMedia(content, text, imageUrl || approvalMeta?.file_url || audioUrl, approvalMeta?.file_name);
    if (role === "email") content = `<strong>${escapeHtml(t("chat.reply.mail"))}${approvalMeta?.from ? ` · ${escapeHtml(approvalMeta.from)}` : ""}</strong><br>${content}`;

    const msgId = safeMsgId(id);
    div.setAttribute("data-msg-id", msgId);
    div.innerHTML = `${replyMeta ? quoteHtml(replyMeta) : ""}${content}${time ? `<span class="time">${escapeHtml(time)}</span>` : ""}<div class="reaction-display" id="reactions-${escapeAttr(msgId)}"></div>`;

    let pressTimer = null;
    div.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => showEmojiPicker(div, msgId), 500);
    }, { passive: true });
    div.addEventListener("touchend", () => clearTimeout(pressTimer));
    div.addEventListener("touchmove", () => clearTimeout(pressTimer));
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showEmojiPicker(div, msgId);
    });

    // Read "at the bottom" before appending: the new message's height would push
    // the view out of the slack and stop the reply from being followed.
    const wasAtBottom = atBottom();
    messagesEl.appendChild(div);
    scrollToBottom(role === "user" || wasAtBottom);
    if (approvalId) {
      updateApproval(approvalId, approvalStates.get(approvalId) || "pending");
      refreshApproval(approvalId);
    }
    if (emailId) refreshMailApproval(emailId);
  }

  function addVoiceMessage(role, text, ts, id, audioUrl, duration, replyMeta) {
    const div = document.createElement("div");
    div.className = `message ${role} voice-message`;
    div.style.maxWidth = "160px";
    div.style.padding = "4px 8px";
    div.style.whiteSpace = "normal";
    const msgId = safeMsgId(id);
    div.setAttribute("data-msg-id", msgId);
    const time = ts ? formatTime(ts) : "";
    const dur = duration ? formatDuration(duration) : "0:00";

    const bars = 16;
    let barsHtml = "";
    for (let i = 0; i < bars; i++) {
      const h = 3 + Math.random() * 10;
      barsHtml += `<div class="wave-bar" style="height:${h}px"></div>`;
    }

    div.innerHTML = `${replyMeta ? quoteHtml(replyMeta) : ""}
      <div class="voice-bubble">
        <button class="voice-play-btn" data-audio="${escapeAttr(audioUrl)}" data-playing="false">
          <svg class="voice-play-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <svg class="voice-pause-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none">
            <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
          </svg>
        </button>
        <div class="voice-wave-container">
          <div class="voice-waveform">${barsHtml}</div>
          <div class="voice-progress" style="width:0%"></div>
        </div>
        <span class="voice-duration">${escapeHtml(dur)}</span>
      </div>
      ${time ? `<span class="time">${escapeHtml(time)}</span>` : ""}
      <div class="reaction-display" id="reactions-${escapeAttr(msgId)}"></div>
    `;

    const playBtn = div.querySelector(".voice-play-btn");
    playBtn.onclick = function(e) {
      e.preventDefault();
      e.stopPropagation();
      handleVoicePlay(div, audioUrl);
    };

    let pressTimer = null;
    div.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => showEmojiPicker(div, msgId), 500);
    }, { passive: true });
    div.addEventListener("touchend", () => clearTimeout(pressTimer));
    div.addEventListener("touchmove", () => clearTimeout(pressTimer));
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showEmojiPicker(div, msgId);
    });

    // Read "at the bottom" before appending: the new message's height would push
    // the view out of the slack and stop the reply from being followed.
    const wasAtBottom = atBottom();
    messagesEl.appendChild(div);
    scrollToBottom(role === "user" || wasAtBottom);
  }

  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // One shared audio element, created from a user gesture: iOS refuses playback otherwise.
  let sharedAudio = null;
  let currentVoiceDiv = null;

  function handleVoicePlay(div, audioUrl) {
    const playIcon = div.querySelector(".voice-play-icon");
    const pauseIcon = div.querySelector(".voice-pause-icon");
    const durationEl = div.querySelector(".voice-duration");
    const bars = div.querySelectorAll(".wave-bar");

    if (!sharedAudio) {
      sharedAudio = new Audio();
    }

    if (currentVoiceDiv === div && !sharedAudio.paused) {
      sharedAudio.pause();
      playIcon.style.display = "";
      pauseIcon.style.display = "none";
      return;
    }

    if (currentVoiceDiv && currentVoiceDiv !== div) {
      currentVoiceDiv.querySelector(".voice-play-icon").style.display = "";
      currentVoiceDiv.querySelector(".voice-pause-icon").style.display = "none";
      currentVoiceDiv.querySelectorAll(".wave-bar").forEach(b => b.classList.remove("played"));
    }

    if (currentVoiceDiv === div && sharedAudio.paused && sharedAudio.currentTime > 0) {
      sharedAudio.play();
      playIcon.style.display = "none";
      pauseIcon.style.display = "";
      return;
    }

    currentVoiceDiv = div;
    sharedAudio.src = audioUrl;
    playIcon.style.display = "none";
    pauseIcon.style.display = "";

    sharedAudio.play().catch(err => {
      console.error("Audio play failed:", err);
      playIcon.style.display = "";
      pauseIcon.style.display = "none";
    });

    sharedAudio.ontimeupdate = () => {
      if (sharedAudio.duration && currentVoiceDiv === div) {
        const pct = (sharedAudio.currentTime / sharedAudio.duration) * 100;
        durationEl.textContent = formatDuration(sharedAudio.duration - sharedAudio.currentTime);
        const activeBar = Math.floor((pct / 100) * bars.length);
        bars.forEach((b, i) => {
          if (i <= activeBar) b.classList.add("played");
          else b.classList.remove("played");
        });
      }
    };

    sharedAudio.onended = () => {
      playIcon.style.display = "";
      pauseIcon.style.display = "none";
      bars.forEach(b => b.classList.remove("played"));
      if (sharedAudio.duration) durationEl.textContent = formatDuration(sharedAudio.duration);
      currentVoiceDiv = null;
    };
  }

  const EMOJIS = [
    { key: "heart", char: "\u2764\uFE0F" },
    { key: "fire", char: "\uD83D\uDD25" },
    { key: "laugh", char: "\uD83D\uDE02" },
    { key: "wow", char: "\uD83D\uDE2E" },
    { key: "thumbsup", char: "\uD83D\uDC4D" },
    { key: "shy", char: "\uD83E\uDD2D" },
    { key: "oops", char: "\uD83D\uDE48" },
    { key: "sad", char: "\uD83D\uDE22" },
  ];

  function showEmojiPicker(msgEl, msgId) {
    const old = document.querySelector(".emoji-picker");
    if (old) old.remove();

    // Built as elements with listeners: no inline handler (script policy,
    // and the id never passes through markup).
    const picker = document.createElement("div");
    picker.className = "emoji-picker";
    const addButton = (label, onTap, title) => {
      const b = document.createElement("button");
      b.className = title ? "emoji-btn reply-btn" : "emoji-btn";
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener("click", onTap);
      picker.appendChild(b);
    };
    for (const e of EMOJIS) addButton(e.char, () => window.sendReaction(msgId, e.char));
    addButton("↩", () => window.startReply(msgId), t("chat.picker.reply"));
    addButton("⧉", () => window.copyMessage(msgId), t("chat.picker.copy"));
    addButton("¶", () => window.enableSelect(msgId), t("chat.picker.select"));

    msgEl.appendChild(picker);

    // Under the newest message the picker's second row would sit behind the
    // input bar: bring it into view once it is laid out.
    setTimeout(() => {
      try { picker.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch {}
    }, 60);

    setTimeout(() => {
      document.addEventListener("touchstart", function closePickerHandler(ev) {
        if (!picker.contains(ev.target)) {
          picker.remove();
          document.removeEventListener("touchstart", closePickerHandler);
        }
      });
    }, 100);
  }

  window.sendReaction = async function(msgId, emoji) {
    const picker = document.querySelector(".emoji-picker");
    if (picker) picker.remove();

    if (!msgId) return;

    addReactionToMessage(msgId, emoji, "User");

    try {
      await fetch("/api/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: msgId, emoji, from: "User" }),
      });
    } catch (err) {
      console.error("React failed:", err);
    }
  };

  function addReactionToMessage(msgId, emoji, from) {
    const display = document.getElementById(`reactions-${msgId}`);
    if (!display) return;
    const existing = display.querySelector(`[data-emoji="${emoji}"]`);
    if (existing) {
      existing.classList.add("active");
      return;
    }
    const span = document.createElement("span");
    span.className = "reaction-badge active";
    span.setAttribute("data-emoji", emoji);
    span.textContent = emoji;
    display.appendChild(span);
  }

  const doctorBtn = document.getElementById("doctor-btn");
  let doctorExpiryTimer;
  function setDoctorBadge(status, summary) {
    if (typeof status === "object" && status) {
      clearTimeout(doctorExpiryTimer);
      const deadlines = (status.checks || []).map((c) => Date.parse(c.muted_until)).filter((n) => n > Date.now());
      if (deadlines.length) doctorExpiryTimer = setTimeout(loadDoctorStatus, Math.min(...deadlines) - Date.now() + 50);
    }
    const state = typeof status === "object" ? status.badge_state || status.state : status;
    const muted = typeof status === "object" ? status.muted || 0 : 0;
    if (typeof status === "object") summary = status.summary;
    if (!doctorBtn) return;
    doctorBtn.classList.remove("doctor-ok", "doctor-warn", "doctor-fail");
    if (state === "warn") doctorBtn.classList.add("doctor-warn");
    else if (state === "fail") doctorBtn.classList.add("doctor-fail");
    else doctorBtn.classList.add("doctor-ok");
    if (summary) {
      doctorBtn.title = t("header.doctor.summary", { pass: summary.pass || 0, warn: summary.warn || 0, fail: summary.fail || 0 });
    }
    if (muted) doctorBtn.title = t("doctor.badgeMuted", { state: state === "fail" ? t("doctor.red") : state === "warn" ? t("doctor.yellow") : t("doctor.green"), count: muted });
    try {
      localStorage.setItem("doctor-state", state);
      if (summary) localStorage.setItem("doctor-summary", JSON.stringify(summary));
    } catch { /* localStorage unavailable */ }
  }

  (function applyStoredBadge() {
    try {
      const state = localStorage.getItem("doctor-state");
      const summary = JSON.parse(localStorage.getItem("doctor-summary") || "null");
      if (state) setDoctorBadge(state, summary);
    } catch { /* ignore */ }
  })();

  async function loadDoctorStatus() {
    try {
      const res = await fetch("/api/internal/doctor/status", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.state && data.state !== "unknown") setDoctorBadge(data);
    } catch { /* offline ok */ }
  }
  loadDoctorStatus();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadDoctorStatus();
  });

  if (doctorBtn) {
    doctorBtn.addEventListener("click", async () => {
      doctorBtn.disabled = true;
      doctorBtn.classList.add("running");
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
      try {
        const res = await fetch("/api/internal/doctor?mode=online&verbose=1", { credentials: "include", signal: controller.signal });
        const data = await res.json();
        renderDoctorReport(data);
        if (data.report?.summary) {
          const s = data.report.summary;
          setDoctorBadge(data.status || { ...data.report, state: s.fail > 0 ? "fail" : s.warn > 0 ? "warn" : "ok" });
        }
      } catch (e) {
        // A timeout proves no service failure, so the badge keeps its last state.
        if (timedOut) renderDoctorReport({ timeout: true });
        else { renderDoctorReport({ error: String(e) }); setDoctorBadge("fail", null); }
      } finally {
        clearTimeout(timeout);
        doctorBtn.disabled = false;
        doctorBtn.classList.remove("running");
      }
    });
  }

  function renderDoctorReport(data) {
    const main = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "doctor-report";
    if (data.timeout) {
      div.textContent = t("doctor.timeout");
    } else if (data.error) {
      div.textContent = t("doctor.error", { error: data.error });
    } else if (data.report) {
      div.innerHTML = doctorReportHtml(data.report);
      div.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-doctor-mute]");
        if (!button || !div.contains(button) || button.disabled) return;
        button.disabled = true;
        const id = button.dataset.doctorMute;
        try {
          const res = await fetch("/api/doctor/mute", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
          });
          if (!res.ok) throw new Error(String(res.status));
          const result = await res.json();
          setDoctorBadge(result.status);
          const check = result.status.checks.find((c) => c.id === id);
          if (check) button.closest(".doctor-check").outerHTML = doctorCheckHtml(check);
        } catch {
          button.disabled = false;
          button.title = t("doctor.muteFailed");
          let error = div.querySelector(".doctor-mute-error");
          if (!error) {
            error = document.createElement("small");
            error.className = "doctor-mute-error";
            error.setAttribute("role", "alert");
            div.appendChild(error);
          }
          error.textContent = t("doctor.muteFailed");
        }
      });
    } else {
      div.textContent = JSON.stringify(data).slice(0, 500);
    }
    main.appendChild(div);
    main.scrollTop = main.scrollHeight;
  }

  let replyTo = null;

  function messageSnippet(div) {
    const clone = div.cloneNode(true);
    clone.querySelectorAll(".time, .reaction-display, .emoji-picker, .msg-quote").forEach(el => el.remove());
    const t = (clone.textContent || "").trim().replace(/\s+/g, " ");
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
  }

  window.startReply = function(msgId) {
    const picker = document.querySelector(".emoji-picker");
    if (picker) picker.remove();
    const div = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!div) return;
    replyTo = {
      id: msgId,
      snippet: messageSnippet(div),
      role: div.classList.contains("email") ? "email" : div.classList.contains("assistant") ? "assistant" : "user",
    };
    forgetEditedMessage();
    showReplyBar();
    inputEl.focus();
  };

  function showReplyBar() {
    hideReplyBar();
    if (!replyTo) return;
    const bar = document.createElement("div");
    bar.id = "reply-bar";
    const who = replyTo.role === "email" ? t("chat.reply.mail") : replyTo.role === "assistant" ? t("chat.reply.them") : t("chat.reply.you");
    bar.innerHTML = `<div class="reply-bar-quote"><span class="reply-bar-who">${escapeHtml(who)}</span>${escapeHtml(replyTo.snippet)}</div><button id="reply-bar-cancel" aria-label="${escapeAttr(t("chat.reply.cancel"))}">×</button>`;
    const inputArea = document.getElementById("input-area");
    inputArea.insertBefore(bar, inputArea.firstChild);
    document.getElementById("reply-bar-cancel").addEventListener("click", () => {
      replyTo = null;
      forgetEditedMessage();
      hideReplyBar();
    });
  }

  function hideReplyBar() {
    const old = document.getElementById("reply-bar");
    if (old) old.remove();
  }

  window.jumpToMessage = function(msgId) {
    const target = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash-highlight");
    setTimeout(() => target.classList.remove("flash-highlight"), 1600);
  };

  function messageSnippetFull(div) {
    const clone = div.cloneNode(true);
    clone.querySelectorAll(".time, .reaction-display, .emoji-picker, .msg-quote").forEach(el => el.remove());
    return (clone.textContent || "").trim();
  }

  // Copy through the picker: user-select is off globally, so the iOS selection menu does not fight long-press reactions.
  window.copyMessage = function(msgId) {
    const picker = document.querySelector(".emoji-picker");
    if (picker) picker.remove();
    const div = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!div) return;
    const text = (div._rawText && div._rawText.trim()) || messageSnippetFull(div);
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  window.enableSelect = function(msgId) {
    const picker = document.querySelector(".emoji-picker");
    if (picker) picker.remove();
    document.querySelectorAll(".message.selectable").forEach(el => el.classList.remove("selectable"));
    const div = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (div) div.classList.add("selectable");
  };
  document.addEventListener("touchstart", (e) => {
    const sel = document.querySelector(".message.selectable");
    if (sel && !sel.contains(e.target)) sel.classList.remove("selectable");
  }, { passive: true });

  function setupScrollButton() {
    const btn = document.getElementById("scroll-bottom-btn");
    if (!btn) return;
    function update() {
      const threshold = Math.max(300, messagesEl.clientHeight * 1.5);
      const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      if (distance > threshold || btn.classList.contains("has-new")) {
        btn.classList.add("visible");
      } else {
        btn.classList.remove("visible");
      }
    }
    messagesEl.addEventListener("scroll", () => {
      update();
      if (atBottom()) clearNewMessage();
    }, { passive: true });
    btn.addEventListener("click", () => {
      clearNewMessage();
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    });
    update();
  }

  function formatTime(ts) {
    return I18N.formatTime(ts);
  }

  // Follow new messages only at the bottom or after sending; otherwise mark
  // the scroll button so incoming messages do not interrupt reading.
  const FOLLOW_SLACK_PX = 120;
  function atBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= FOLLOW_SLACK_PX;
  }
  function markNewMessage() {
    const btn = document.getElementById("scroll-bottom-btn");
    if (!btn) return;
    btn.classList.add("has-new", "visible");
    btn.setAttribute("aria-label", t("chat.newMessageScroll"));
  }
  function clearNewMessage() {
    const btn = document.getElementById("scroll-bottom-btn");
    if (!btn) return;
    btn.classList.remove("has-new");
    btn.setAttribute("aria-label", t("chat.scrollBottom"));
  }
  function scrollToBottom(force = false) {
    if (!force && !atBottom()) { markNewMessage(); return; }
    clearNewMessage();
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function showTyping() {
  }

  let lastSentText = "";
  let lastSentTime = 0;
  let messageSending = false;
  let pendingImages = [];
  let pendingTextSend = null;

  function forgetEditedMessage() {
    if (pendingTextSend && (pendingTextSend.draft !== inputEl.value || pendingTextSend.replyId !== (replyTo?.id || ""))) {
      pendingTextSend = null;
    }
  }
  inputEl.addEventListener("input", forgetEditedMessage);

  function isImageFile(file) {
    return /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(file.name || "");
  }

  function attachmentFeatureEnabled(file) {
    return isImageFile(file) ? featureEnabled("photos") : featureEnabled("files");
  }

  function updateAttachmentPicker() {
    if (!imageBtn || !imageInput) return;
    const photos = featureEnabled("photos");
    const files = featureEnabled("files");
    const hidden = !photos && !files;
    imageBtn.hidden = hidden;
    imageBtn.style.display = hidden ? "none" : "flex";
    if (photos && files) {
      imageInput.removeAttribute("accept");
    } else {
      imageInput.accept = photos
        ? "image/jpeg,image/png,image/gif,image/webp,image/heic"
        : "application/pdf,text/*,.csv,.json,.xml,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,audio/*,video/*";
    }
  }
  updateAttachmentPicker();

  // A refused upload must say why; the server answers 413 for size and 415 for type, and a proxy may answer without JSON.
  function uploadRefusal(status, name) {
    if (status === 413) return t("chat.uploadTooLarge", { name });
    if (status === 415) return t("chat.uploadNotAllowed", { name });
    return t("chat.uploadFailed", { name });
  }

  async function sendMessage() {
    if (messageSending) return;
    const draft = inputEl.value;
    const text = draft.trim();
    const restoreCaption = () => {
      if (!inputEl.value) {
        inputEl.value = draft;
        inputEl.style.height = "auto";
        inputEl.style.height = inputEl.scrollHeight + "px";
        try { localStorage.setItem(DRAFT_KEY, draft); } catch {}
      }
    };

    if (pendingImages.length > 0) {
      const files = pendingImages.slice().filter(attachmentFeatureEnabled);
      const caption = text;
      if (files.length !== pendingImages.length) {
        pendingImages = files;
        if (files.length > 0) showImagePreview();
        else hideImagePreview();
      }
      if (files.length === 0) return;
      // Reset state before upload so the button does not fire twice
      pendingImages = [];
      hideImagePreview();
      inputEl.value = ""; try { localStorage.removeItem(DRAFT_KEY); } catch {}
      inputEl.style.height = "auto";
      sendBtn.disabled = true;
      uploadsInFlight++;
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const formData = new FormData();
          formData.append("image", file);
          if (i === 0 && caption) formData.append("caption", caption);

          try {
            const res = await fetch("/api/image", { method: "POST", body: formData });
            const data = await res.json().catch(() => null);
            if (res.ok && data?.ok) {
              const isImage = /\.(jpg|jpeg|png|gif|webp|svg|heic)$/i.test(file.name) || file.type?.startsWith("image/");
              const fallback = isImage ? "[Image]" : `[File: ${file.name}]`;
              const label = (i === 0 && caption) ? caption : fallback;
              addMessage("user", label, new Date().toISOString(), data.id, data.image_url);
            } else {
              if (i === 0) restoreCaption();
              addMessage("user", uploadRefusal(res.status, file.name), new Date().toISOString());
            }
          } catch (err) {
            if (i === 0) restoreCaption();
            console.error("Upload failed:", err);
            addMessage("user", t("chat.uploadFailed", { name: file.name }), new Date().toISOString());
          }
        }
      } finally {
        uploadsInFlight--;
      }

      sendBtn.disabled = false;
      inputEl.focus();
      return;
    }

    if (!text) return;

    const now = Date.now();
    if (text === lastSentText && now - lastSentTime < 3000) return;
    const sentReplyTo = replyTo;
    forgetEditedMessage();
    if (!pendingTextSend) {
      const random = typeof crypto === "undefined" ? null : crypto;
      const clientId = random?.randomUUID?.() || (random?.getRandomValues
        ? Array.from(random.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`);
      pendingTextSend = { clientId, draft, replyId: sentReplyTo?.id || "" };
    }
    const sentAttempt = pendingTextSend;
    messageSending = true;
    sendBtn.disabled = true;
    try { localStorage.setItem(DRAFT_KEY, draft); } catch {}

    try {
      const body = JSON.stringify({ text, client_id: sentAttempt.clientId, ...(sentReplyTo ? { reply_to: sentReplyTo } : {}) });
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        try {
          res = await fetch("/api/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          break;
        } catch (error) {
          // Only a missing response is retried; slash commands are not replay-protected.
          if (attempt === 2 || text.startsWith("/")) throw error;
        }
      }
      const data = await res.json();
      if (!res.ok || data?.ok !== true || typeof data.id !== "string" || !data.id || data.blocked) {
        throw new Error("Send not confirmed");
      }
      if (pendingTextSend === sentAttempt) pendingTextSend = null;
      lastSentText = text;
      lastSentTime = Date.now();
      if (inputEl.value === draft) {
        inputEl.value = "";
        inputEl.style.height = "auto";
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
      }
      if (replyTo === sentReplyTo) {
        replyTo = null;
        hideReplyBar();
      }
      addMessage("user", text, new Date().toISOString(), data.id, undefined, undefined, undefined, sentReplyTo);
    } catch {
      // The composer stays intact until confirmation, including its reply target.
      window.alert(t("chat.sendFailed"));
    } finally {
      messageSending = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  function showImagePreview() {
    let preview = document.getElementById("image-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.id = "image-preview";
      const inputArea = document.getElementById("input-area");
      const inputRow = document.getElementById("input-row");
      inputArea.insertBefore(preview, inputRow);
    }
    preview.innerHTML = "";

    pendingImages.forEach((file, idx) => {
      const item = document.createElement("div");
      item.className = "image-preview-item";

      const isImage = file.type?.startsWith("image/");
      if (isImage) {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.alt = file.name;
        item.appendChild(img);
      } else {
        const fileLabel = document.createElement("span");
        fileLabel.textContent = file.name;
        item.appendChild(fileLabel);
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "image-preview-remove";
      removeBtn.textContent = "×";
      removeBtn.title = t("chat.removeImage");
      removeBtn.addEventListener("click", () => {
        pendingImages.splice(idx, 1);
        if (pendingImages.length === 0) {
          hideImagePreview();
        } else {
          showImagePreview();
        }
        inputEl.focus();
      });
      item.appendChild(removeBtn);

      preview.appendChild(item);
    });
  }

  function hideImagePreview() {
    const preview = document.getElementById("image-preview");
    if (preview) preview.remove();
  }

  let wsHeartbeat = null;
  let wsLastPong = 0;
  let pollFallback = null;
  let reconnectAttempt = 0;
  let wsProbeTimer = null;
  const WS_PROBE_MS = 4000;
  const WS_CONNECT_TIMEOUT_MS = 10000;

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Every connection keeps its own handle, so late events from a connection
    // that has already been replaced can be recognised and ignored.
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    ws = sock;
    // If the handshake hangs (iOS right after waking up, network not back
    // yet), neither open nor close arrives; do not wait forever.
    const connectTimer = setTimeout(() => {
      if (ws === sock && sock.readyState === WebSocket.CONNECTING) dropWs("connect timeout");
    }, WS_CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      clearTimeout(connectTimer);
      console.log("WebSocket connected");
      clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      wsLastPong = Date.now();
      document.getElementById("status")?.classList.remove("disconnected");
      startWsHeartbeat();
      stopPollFallback();
      catchUpMessages();
      if (typeof syncModel === "function") syncModel();
      if (terminalOpen && terminalPanelEnabled()) sendTerminalSubscription(true);
    };

    sock.onmessage = (event) => {
      wsLastPong = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "pong") return;
        if (msg.type === "message" && msg.data) {
          showTyping(false);
          addMessage("assistant", msg.data.text, msg.data.ts, msg.data.id, msg.data.image_url, msg.data.audio_url, msg.data.duration, msg.data.reply_to, msg.data);
        } else if (msg.type === "email-approval" && msg.data) {
          updateMailApproval(msg.data.id, msg.data.status);
        } else if (msg.type === "house-question") {
          refreshHouseQuestion();
        } else if (msg.type === "approval" && msg.data) {
          updateApproval(msg.data.id, msg.data.status);
        } else if (msg.type === "doctor-status" && msg.data) {
          if (msg.data.state && msg.data.state !== "unknown") {
            setDoctorBadge(msg.data);
          }
        } else if (msg.type === "terminal-subscribed") {
          renderTerminalInputVisibility(msg.input_enabled === true);
        } else if (msg.type === "terminal-input-ack" || msg.type === "terminal-input-error") {
          if (msg.request_id !== undefined && msg.request_id === terminalInputRequest?.id) {
            const request = terminalInputRequest;
            terminalInputRequest = null;
            if (msg.type === "terminal-input-ack") settleTerminalInput(true, "", request);
            else settleTerminalInput(false, msg.error || "Terminal input failed", request);
          }
        } else if (msg.type === "terminal-input-disabled" || msg.type === "terminal-input-not-subscribed") {
          terminalInputRequest = null;
          terminalSubscribed = false;
          settleTerminalInput(false, msg.type);
          renderTerminalInputVisibility(false);
        } else if (msg.type === "terminal-frame") {
          renderTerminalFrame(msg);
        } else if (msg.type === "terminal-alive") {
          markTerminalAlive();
        } else if (msg.type === "terminal-disabled") {
          closeTerminal();
        } else if (msg.type === "reaction" && msg.data) {
          addReactionToMessage(msg.data.message_id, msg.data.emoji, msg.data.from);
        } else if (msg.type === "ack") {
        }
      } catch {}
    };

    sock.onclose = (event) => {
      clearTimeout(connectTimer);
      // Session expiry reloads the login gate instead of retrying an unauthorized socket.
      if (ws === sock && event?.code === 4001) {
        sock.onclose = null;
        clearTimeout(reconnectTimer);
        stopWsProbe();
        stopWsHeartbeat();
        stopPollFallback();
        location.reload();
        return;
      }
      // A late close from a connection that has already been replaced must
      // not touch the current one (it would stop the new heartbeat).
      if (ws !== sock) return;
      ws = null;
      console.log("WebSocket disconnected");
      wsDown("WebSocket disconnected");
      scheduleReconnect();
    };

    sock.onerror = () => {
      if (ws !== sock) return;
      dropWs("WebSocket error");
    };
  }

  function wsDown(reason) {
    stopWsProbe();
    terminalInputRequest = null;
    renderTerminalInputVisibility(false);
    settleTerminalInput(false, reason);
    stopWsHeartbeat();
    document.getElementById("status")?.classList.add("disconnected");
    if (terminalOpen && terminalFreshness) terminalFreshness.textContent = t("terminal.connecting");
    startPollFallback();
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempt), 30000) + Math.random() * 1000;
    reconnectAttempt++;
    reconnectTimer = setTimeout(connectWs, delay);
  }

  // Replace a dead socket without waiting for iOS's unreliable close event;
  // handlers are detached first so late events cannot reach the new one.
  function dropWs(reason, now = false) {
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try { old.close(); } catch {}
    }
    console.log(`WebSocket given up (${reason})`);
    wsDown(reason);
    if (now) {
      clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      connectWs();
    } else {
      scheduleReconnect();
    }
  }

  // iOS keeps reporting a socket it cut in the background as OPEN, so readyState
  // says nothing: send a ping, and replace the connection if no answer comes.
  function checkWsAlive(why) {
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      dropWs(`${why}: no open connection`, true);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || wsProbeTimer) return;
    const sock = ws;
    const sentAt = Date.now();
    try { sock.send(JSON.stringify({ type: "ping" })); } catch {}
    wsProbeTimer = setTimeout(() => {
      wsProbeTimer = null;
      if (ws === sock && wsLastPong < sentAt) dropWs(`${why}: no answer`, true);
    }, WS_PROBE_MS);
  }

  function stopWsProbe() {
    if (wsProbeTimer) { clearTimeout(wsProbeTimer); wsProbeTimer = null; }
  }

  function startWsHeartbeat() {
    stopWsHeartbeat();
    wsHeartbeat = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
        // A dead socket does not reliably deliver its close event, so the connection
        // is given up instead of closed.
        if (Date.now() - wsLastPong > 10000 && !wsProbeTimer) dropWs("heartbeat timeout");
      }
    }, 5000);
  }

  function stopWsHeartbeat() {
    if (wsHeartbeat) { clearInterval(wsHeartbeat); wsHeartbeat = null; }
  }

  function startPollFallback() {
    if (pollFallback) return;
    pollFallback = setInterval(() => {
      catchUpMessages();
    }, 3000);
  }

  function stopPollFallback() {
    if (pollFallback) { clearInterval(pollFallback); pollFallback = null; }
  }

  async function loadHistory() {
    try {
      const res = await fetch("/api/messages");
      const messages = await res.json();
      for (const msg of messages) {
        addMessage(msg.role, msg.text, msg.ts, msg.id, msg.image_url, msg.audio_url, msg.duration, msg.reply_to, msg);
      }
      await loadStoredReactions();
    } catch (err) {
      console.error("Failed to load history:", err);
    }
    scrollToBottom(true);
  }

  const terminalBtn = document.getElementById("terminal-btn");
  const terminalPanel = document.getElementById("terminal-panel");
  const terminalCloseBtn = document.getElementById("terminal-close-btn");
  const terminalScroll = document.getElementById("terminal-scroll");
  const terminalOutput = document.getElementById("terminal-output");
  const terminalLiveBtn = document.getElementById("terminal-live-btn");
  const terminalFreshness = document.getElementById("terminal-freshness");
  const terminalHistoryState = document.getElementById("terminal-history-state");
  const terminalInputTools = document.getElementById("terminal-input-tools");
  const terminalInput = document.getElementById("terminal-input");
  const terminalInputSend = document.getElementById("terminal-input-send");
  const terminalKeybar = document.getElementById("terminal-keybar");
  let terminalOpen = false;
  let terminalSubscribed = false;
  let terminalInputEnabled = false;
  let terminalMode = "log";
  const terminalModeBtn = document.getElementById("terminal-mode-btn");
  let terminalModifier = null;
  let terminalPendingSubmit = null;
  let terminalInputRequest = null;
  let terminalInputRequestSerial = 0;
  let terminalFollowing = true;
  let terminalLastFrameAt = 0;
  let terminalHistoryOffset = 0;
  let terminalHistoryLoading = false;
  let terminalHasMoreHistory = true;
  let terminalLogLive = [];
  let terminalLogHistory = [];
  let terminalPendingLogFrame = null;
  let terminalLogAnchorLost = false;
  // Each fresh look has its own number: a page of older output asked for in an
  // earlier look never lands in this one.
  let terminalViewSerial = 0;
  let terminalAwaitingFrame = true;
  let terminalReaderMoved = false;

  function clearTerminalModifierButtons() {
    terminalKeybar?.querySelectorAll("[data-terminal-modifier]").forEach((button) => button.classList.remove("active"));
  }
  function settleTerminalInput(ok, error = "", request = null) {
    const pending = terminalPendingSubmit;
    if (!pending) return;
    if (request && request.kind !== pending.phase) return;
    if (!ok) {
      terminalPendingSubmit = null;
      if (terminalInput) terminalInput.readOnly = false;
      if (error) console.warn(error);
      terminalInput?.focus();
      return;
    }
    if (pending.phase === "text") {
      pending.phase = "enter";
      setTimeout(() => {
        if (terminalPendingSubmit !== pending) return;
        if (!sendTerminalInput({ key: "Enter" }, "enter")) {
          terminalPendingSubmit = null;
          if (terminalInput) terminalInput.readOnly = false;
          terminalInput?.focus();
        }
      }, 1200);
      return;
    }
    terminalPendingSubmit = null;
    if (terminalInput) {
      terminalInput.readOnly = false;
      terminalInput.value = "";
      terminalInput.focus();
    }
    // No follow-up Enter after a slash command: it opens an interactive dialog,
    // and Enter would confirm the selection before the user sees it.
    if (pending.slash) return;
    setTimeout(() => { if (!terminalPendingSubmit) sendTerminalInput({ key: "Enter" }, "direct"); }, 1200);
  }
  function renderTerminalInputVisibility(visible) {
    terminalInputEnabled = visible;
    terminalSubscribed = true;
    if (!visible) {
      terminalSubscribed = false;
      terminalModifier = null;
      clearTerminalModifierButtons();
      settleTerminalInput(false, "Terminal input unavailable");
    }
    if (terminalInputTools) terminalInputTools.hidden = !(terminalOpen && terminalSubscribed && visible);
  }
  function sendTerminalInput(payload, kind = "direct") {
    if (!terminalOpen || !terminalSubscribed || !terminalInputEnabled || ws?.readyState !== WebSocket.OPEN) return false;
    const request = { id: ++terminalInputRequestSerial, kind };
    terminalInputRequest = request;
    ws.send(JSON.stringify({ type: "terminal-input", request_id: request.id, ...payload }));
    return true;
  }
  function sendTerminalText() {
    if (!terminalInput || terminalPendingSubmit) return;
    const text = terminalInput.value;
    if (!text || Array.from(text).length > 2000) return;
    if (!sendTerminalInput({ text }, "text")) return;
    terminalPendingSubmit = { text, phase: "text", slash: text.trimStart().startsWith("/") };
    terminalInput.readOnly = true;
    terminalModifier = null;
    clearTerminalModifierButtons();
    scrollTerminalLive();
    terminalInput.focus();
  }
  function sendTerminalKey(key, modifier = null) {
    if (terminalPendingSubmit) return;
    const payload = modifier === "ctrl" ? { key, ctrl: true }
      : modifier === "alt" ? { key, alt: true } : { key };
    if (!sendTerminalInput(payload, "direct")) return;
    terminalModifier = null;
    clearTerminalModifierButtons();
    terminalInput?.focus();
  }
  terminalKeybar?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || terminalPendingSubmit) return;
    const modifier = button.dataset.terminalModifier;
    if (modifier) {
      terminalModifier = terminalModifier === modifier ? null : modifier;
      clearTerminalModifierButtons();
      if (terminalModifier === modifier) button.classList.add("active");
      terminalInput?.focus();
      return;
    }
    const key = button.dataset.terminalKey;
    if (key) sendTerminalKey(key, button.dataset.terminalCtrlDirect === "true" ? "ctrl" : terminalModifier);
  });
  terminalInputSend?.addEventListener("click", sendTerminalText);
  terminalInput?.addEventListener("keydown", (event) => {
    if (terminalModifier && event.key.length === 1 && /^[\x20-\x7e]$/.test(event.key)
      && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      sendTerminalKey(event.key, terminalModifier);
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); sendTerminalText(); }
  });
  function sendTerminalSubscription(subscribe) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!subscribe) {
      terminalSubscribed = false;
      terminalInputEnabled = false;
      terminalInputRequest = null;
      terminalInputTools?.setAttribute("hidden", "");
      terminalModifier = null;
      clearTerminalModifierButtons();
      settleTerminalInput(false, "Terminal subscription ended");
    }
    ws.send(JSON.stringify(subscribe ? { type: "terminal-subscribe", mode: terminalMode } : { type: "terminal-unsubscribe" }));
  }
  function terminalLine(html) {
    const line = document.createElement("span");
    line.className = "terminal-line";
    // Only server-sanitized ansiToHtml output reaches this sink.
    line.innerHTML = html;
    return line;
  }
  function renderLogItem(item) {
    if (item && typeof item === "object" && item.summary_html !== undefined) {
      const details = document.createElement("details");
      details.className = "terminal-tool" + (item.error ? " terminal-tool-error" : "");
      const summary = document.createElement("summary");
      // Only server-sanitized ansiToHtml output reaches these sinks.
      summary.innerHTML = item.summary_html;
      const body = document.createElement("div");
      body.className = "terminal-tool-body";
      body.innerHTML = item.body_html;
      details.append(summary, body);
      return details;
    }
    return terminalLine(item && typeof item === "object" ? item.html ?? "" : item ?? "");
  }
  function markTerminalAlive() {
    if (!terminalOpen) return;
    terminalLastFrameAt = Date.now();
    if (terminalFreshness) terminalFreshness.textContent = t("terminal.live");
  }
  function terminalHistoryMoved() {
    terminalLogAnchorLost = true;
    terminalHasMoreHistory = false;
    if (terminalHistoryState) terminalHistoryState.textContent = t("terminal.history.moved");
  }
  function paintTerminalFrame(msg) {
    const oldTop = terminalScroll?.scrollTop;
    const history = terminalOutput.querySelector(".terminal-history");
    const openKeys = new Set();
    // Identity, not summary text, keeps equally named tools independent across updates.
    for (const container of terminalOutput.children) {
      for (const node of container.children) if (node.tagName === "DETAILS" && node.open) openKeys.add(node.dataset.logKey);
    }
    terminalOutput.replaceChildren();
    const appendItems = (container, items) => {
      for (const item of items) {
        const node = renderLogItem(item);
        node.dataset.logKey = item.key;
        if (node.tagName === "DETAILS" && openKeys.has(item.key)) node.open = true;
        container.appendChild(node);
      }
    };
    if (terminalMode === "log" && terminalLogHistory.length) {
      const older = document.createElement("span");
      older.className = "terminal-history";
      appendItems(older, terminalLogHistory);
      terminalOutput.appendChild(older);
    } else if (terminalMode === "tui" && history) terminalOutput.appendChild(history);
    const live = document.createElement("span");
    live.className = "terminal-live-frame";
    if (terminalMode === "log") appendItems(live, terminalLogLive);
    else for (const html of msg.lines || []) live.appendChild(terminalLine(html));
    terminalOutput.appendChild(live);
    if (terminalAwaitingFrame) {
      terminalAwaitingFrame = false;
      scrollTerminalLive();
      requestAnimationFrame(settleTerminalAtNewest);
    } else if (terminalFollowing) scrollTerminalLive();
    else if (terminalScroll) terminalScroll.scrollTop = oldTop;
  }
  async function terminalLogPage(query, serial) {
    const res = await fetch(`/api/terminal/history?mode=log&lines=200&${query}`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (serial !== terminalViewSerial || !terminalOpen) return null;
    if (data.anchor_lost) { terminalHistoryMoved(); return null; }
    return data;
  }
  function flushTerminalLogFrame(serial) {
    if (serial !== terminalViewSerial) return;
    terminalHistoryLoading = false;
    const pending = terminalPendingLogFrame;
    terminalPendingLogFrame = null;
    if (pending && !terminalLogAnchorLost) renderTerminalFrame(pending);
  }
  async function updateTerminalLog(msg) {
    const serial = terminalViewSerial;
    terminalHistoryLoading = true;
    try {
      const next = msg.items || [];
      if (terminalLogHistory.length && terminalLogLive.length && next.length) {
        const first = next[0].key;
        const overlap = terminalLogLive.findIndex((item) => item.key === first);
        const dropped = overlap >= 0 ? terminalLogLive.slice(0, overlap) : terminalLogLive;
        const gap = [];
        if (overlap < 0 && !terminalLogHistory.some((item) => item.key === first)) {
          let after = terminalLogLive[terminalLogLive.length - 1].key;
          do {
            const data = await terminalLogPage(`after=${encodeURIComponent(after)}&before=${encodeURIComponent(first)}`, serial);
            if (!data) return;
            gap.push(...(data.lines || []));
            after = data.nextAfter;
          } while (after);
        }
        terminalLogHistory.push(...dropped, ...gap);
        const at = terminalLogHistory.findIndex((item) => item.key === first);
        if (at >= 0) terminalLogHistory = terminalLogHistory.slice(0, at);
        // Retaining a moving tail must not turn the bounded log into unbounded browser storage.
        terminalLogHistory = terminalLogHistory.slice(-(5000 - next.length));
      }
      terminalLogLive = next;
      paintTerminalFrame(msg);
    } catch {
      if (serial === terminalViewSerial && terminalHistoryState) terminalHistoryState.textContent = t("terminal.history.unavailable");
    } finally { flushTerminalLogFrame(serial); }
  }
  function renderTerminalFrame(msg) {
    if (!terminalOpen || !terminalOutput) return;
    const mode = msg.mode === "log" ? "log" : "tui";
    if (mode !== terminalMode) return;
    terminalLastFrameAt = Date.parse(msg.ts || "") || Date.now();
    if (terminalFreshness) terminalFreshness.textContent = t("terminal.live");
    if (mode === "log") {
      if (terminalLogAnchorLost) return;
      if (terminalHistoryLoading) { terminalPendingLogFrame = msg; return; }
      void updateTerminalLog(msg);
    } else paintTerminalFrame(msg);
  }
  function settleTerminalAtNewest() {
    if (terminalOpen && !terminalReaderMoved && !terminalAwaitingFrame) scrollTerminalLive();
  }
  function resetTerminalView() {
    terminalOutput?.replaceChildren();
    terminalViewSerial++;
    terminalAwaitingFrame = true;
    terminalReaderMoved = false;
    terminalHistoryOffset = 0;
    terminalHistoryLoading = false;
    terminalLogLive = [];
    terminalLogHistory = [];
    terminalPendingLogFrame = null;
    terminalLogAnchorLost = false;
    terminalHasMoreHistory = true;
    terminalFollowing = true;
    terminalLastFrameAt = 0;
    if (terminalHistoryState) terminalHistoryState.textContent = t("terminal.history.hint");
    if (terminalFreshness) terminalFreshness.textContent = t("terminal.connecting");
  }
  function renderTerminalModeBtn() {
    if (terminalModeBtn) terminalModeBtn.textContent = terminalMode === "log" ? t("terminal.mode.log") : t("terminal.mode.tui");
  }
  renderTerminalModeBtn();
  terminalModeBtn?.addEventListener("click", () => {
    terminalMode = terminalMode === "log" ? "tui" : "log";
    renderTerminalModeBtn();
    resetTerminalView();
    if (terminalOpen) sendTerminalSubscription(true);
  });
  function scrollTerminalLive() {
    if (!terminalScroll) return;
    terminalFollowing = true;
    terminalScroll.scrollTop = terminalScroll.scrollHeight;
    terminalLiveBtn?.classList.remove("visible");
  }
  async function loadTerminalHistory() {
    if (!terminalOpen || terminalAwaitingFrame || terminalHistoryLoading || !terminalHasMoreHistory || !terminalOutput || !terminalScroll || !terminalPanelEnabled()) return;
    terminalHistoryLoading = true;
    if (terminalHistoryState) terminalHistoryState.textContent = t("terminal.history.loading");
    const serial = terminalViewSerial;
    try {
      if (terminalMode === "log") {
        const before = (terminalLogHistory[0] || terminalLogLive[0])?.key;
        if (!before) { terminalHistoryMoved(); return; }
        const data = await terminalLogPage(`before=${encodeURIComponent(before)}`, serial);
        if (!data) return;
        const oldHeight = terminalScroll.scrollHeight;
        terminalLogHistory.unshift(...(data.lines || []));
        terminalHasMoreHistory = data.nextBefore != null && (data.lines || []).length > 0;
        paintTerminalFrame({});
        terminalScroll.scrollTop += terminalScroll.scrollHeight - oldHeight;
        if (terminalHistoryState) terminalHistoryState.textContent = terminalHasMoreHistory ? t("terminal.history.more") : t("terminal.history.start");
        return;
      }
      const res = await fetch(`/api/terminal/history?lines=200&offset=${terminalHistoryOffset}&mode=${terminalMode}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (serial !== terminalViewSerial) return;
      const oldHeight = terminalScroll.scrollHeight;
      let history = terminalOutput.querySelector(".terminal-history");
      if (!history) { history = document.createElement("span"); history.className = "terminal-history"; terminalOutput.prepend(history); }
      const fragment = document.createDocumentFragment();
      for (const item of data.lines || []) fragment.appendChild(renderLogItem(item));
      history.prepend(fragment);
      terminalHistoryOffset = data.nextOffset ?? terminalHistoryOffset;
      terminalHasMoreHistory = data.nextOffset !== null && (data.lines || []).length > 0;
      terminalScroll.scrollTop += terminalScroll.scrollHeight - oldHeight;
      if (terminalHistoryState) terminalHistoryState.textContent = terminalHasMoreHistory ? t("terminal.history.more") : t("terminal.history.start");
    } catch { if (serial === terminalViewSerial && terminalHistoryState) terminalHistoryState.textContent = t("terminal.history.unavailable"); }
    finally { flushTerminalLogFrame(serial); }
  }
  function openTerminal() {
    if (!terminalPanelEnabled() || !terminalPanel || terminalOpen) return;
    terminalOpen = true;
    terminalSubscribed = false;
    terminalInputEnabled = false;
    terminalInputTools?.setAttribute("hidden", "");
    resetTerminalView();
    terminalPanel.classList.add("open");
    document.body.classList.add("terminal-split");
    terminalPanel.setAttribute("aria-hidden", "false");
    terminalBtn?.setAttribute("aria-expanded", "true");
    if (terminalFreshness) terminalFreshness.textContent = t("terminal.connecting");
    sendTerminalSubscription(true);
  }
  function closeTerminal() {
    if (!terminalPanel || !terminalOpen) return;
    sendTerminalSubscription(false);
    terminalOpen = false;
    terminalSubscribed = false;
    terminalInputEnabled = false;
    terminalInputTools?.setAttribute("hidden", "");
    terminalPanel.classList.remove("open");
    document.body.classList.remove("terminal-split");
    terminalPanel.setAttribute("aria-hidden", "true");
    terminalBtn?.setAttribute("aria-expanded", "false");
  }
  terminalBtn?.addEventListener("click", openTerminal);
  terminalCloseBtn?.addEventListener("click", closeTerminal);
  terminalLiveBtn?.addEventListener("click", scrollTerminalLive);
  terminalScroll?.addEventListener("scroll", () => {
    const distance = terminalScroll.scrollHeight - terminalScroll.scrollTop - terminalScroll.clientHeight;
    terminalFollowing = distance < 32;
    terminalLiveBtn?.classList.toggle("visible", !terminalFollowing);
    if (terminalScroll.scrollTop < 80) loadTerminalHistory();
  }, { passive: true });
  for (const type of ["touchstart", "wheel", "pointerdown", "keydown"]) {
    terminalScroll?.addEventListener(type, () => { terminalReaderMoved = true; }, { passive: true });
  }
  terminalPanel?.addEventListener("transitionend", (event) => {
    if (event.target === terminalPanel) settleTerminalAtNewest();
  });
  let terminalTouchX = null;
  let terminalTouchY = null;
  document.addEventListener("touchstart", (event) => {
    // The overlay owns gestures even if this listener receives a bubbled event.
    if (document.querySelector(".lightbox-overlay")) { terminalTouchX = terminalTouchY = null; return; }
    const touch = event.changedTouches[0];
    terminalTouchX = touch?.clientX ?? null;
    terminalTouchY = touch?.clientY ?? null;
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    if (document.querySelector(".lightbox-overlay")) { terminalTouchX = terminalTouchY = null; return; }
    if (terminalTouchX === null || terminalTouchY === null) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - terminalTouchX;
    const dy = touch.clientY - terminalTouchY;
    terminalTouchX = terminalTouchY = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (!terminalOpen && dx < 0) openTerminal();
    else if (terminalOpen && dx > 0) closeTerminal();
  }, { passive: true });
  setInterval(() => {
    if (terminalOpen && terminalFreshness && (!terminalLastFrameAt || Date.now() - terminalLastFrameAt > 5000)) terminalFreshness.textContent = t("terminal.connecting");
  }, 1000);

  async function setupPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (!featureEnabled("push")) return;

    // iOS requires explicit permission request from user gesture
    const permission = Notification.permission;
    if (permission === "default") {
      const banner = document.createElement("div");
      banner.id = "push-banner";
      const question = document.createElement("span");
      question.textContent = t("push.prompt");
      const allow = document.createElement("button");
      allow.id = "push-allow";
      allow.textContent = t("push.allow");
      banner.append(question, allow);
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#8B7355;color:white;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;z-index:1000;font-size:14px;";
      banner.querySelector("button").style.cssText = "background:white;color:#8B7355;border:none;border-radius:6px;padding:6px 16px;font-size:14px;font-weight:600;cursor:pointer;";
      document.body.prepend(banner);

      banner.querySelector("#push-allow").addEventListener("click", async () => {
        const result = await Notification.requestPermission();
        banner.remove();
        if (result === "granted") {
          await subscribePush();
        }
      });
      return;
    }

    if (permission === "granted") {
      await subscribePush();
    }
  }

  async function subscribePush() {
    if (!featureEnabled("push")) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      try {
        const res = await fetch("/api/push/vapid-key");
        const { key } = await res.json();
        const vapidKey = urlBase64ToUint8Array(key);

        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey,
        });

        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch (err) {
        console.error("Push subscribe failed:", err);
      }
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  });

  sendBtn.addEventListener("click", sendMessage);

  imageBtn.addEventListener("click", () => {
    if (!featureEnabled("photos") && !featureEnabled("files")) return;
    imageInput.click();
  });
  imageInput.addEventListener("change", () => {
    const files = Array.from(imageInput.files || []).filter(attachmentFeatureEnabled);
    if (!files.length) {
      imageInput.value = "";
      return;
    }

    pendingImages = pendingImages.concat(files);
    showImagePreview();
    imageInput.value = "";
    inputEl.focus();
  });

  const statusDiv = document.createElement("div");
  statusDiv.id = "status";
  statusDiv.textContent = t("chat.connectionLost");
  document.body.prepend(statusDiv);

  // The spoken language can differ from the app's display language.
  function voiceSettings() {
    let look = null;
    try { look = JSON.parse(localStorage.getItem("embervy-appearance") || "null"); } catch {}
    const lang = look && typeof look.speechLang === "string" && look.speechLang ? look.speechLang : I18N.language;
    const whisper = !(look && look.features && look.features.whisper === false);
    return { lang, sendAtOnce: !(look && look.speechSend === false), whisper };
  }

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const WHISPER_OFF = "embervy-whisper-off";
  let recognition = null;
  let listening = false;      // the browser's recognition may write into the field
  let isRecording = false;
  let isStarting = false;
  let isTranscribing = false;
  let recorder = null;
  let recStream = null;
  let recChunks = [];
  let recLang = "";

  function whisperOn() {
    if (!canRecord || !voiceSettings().whisper) return false;
    try { return sessionStorage.getItem(WHISPER_OFF) !== "1"; } catch { return true; }
  }

  function showMic(state) {
    micBtn.classList.toggle("starting", state === "starting");
    micBtn.classList.toggle("recording", state === "recording");
    micBtn.classList.toggle("transcribing", state === "transcribing");
    micBtn.setAttribute("aria-busy", state === "transcribing" ? "true" : "false");
  }

  function setInputText(text) {
    inputEl.value = text;
    inputEl.dispatchEvent?.(new Event("input"));
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  }

  function finishSpeech() {
    if (!inputEl.value.trim()) return;
    if (!voiceSettings().sendAtOnce) {
      inputEl.focus();
      return;
    }
    sendMessage();
    inputEl.value = ""; try { localStorage.removeItem(DRAFT_KEY); } catch {}
    inputEl.style.height = "auto";
  }

  if (SpeechRecognitionAPI) {
    recognition = new SpeechRecognitionAPI();
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      if (!listening) return;
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInputText(transcript);
    };

    // The browser may end recognition early on a pause, so with a recording the recorder's stop decides.
    recognition.onend = () => {
      if (recorder || !isRecording) return;
      isRecording = false;
      listening = false;
      showMic("");
      finishSpeech();
    };

    recognition.onerror = (event) => {
      if (event.error !== "aborted") console.error("Speech error:", event.error);
      if (recorder) return;
      isRecording = false;
      listening = false;
      showMic("");
    };
  }

  // getUserMedia can hang without an answer on iOS: give up after 8 s.
  async function openMicrophone() {
    let timedOut = false;
    const ask = navigator.mediaDevices.getUserMedia({ audio: true });
    ask.then((stream) => { if (timedOut) stream.getTracks().forEach((t) => t.stop()); }).catch(() => {});
    try {
      return await Promise.race([
        ask,
        new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error("microphone timeout")); }, 8000)),
      ]);
    } catch (err) {
      console.warn("Microphone unavailable:", err);
      return null;
    }
  }

  async function startVoice() {
    if (isRecording || isStarting || isTranscribing) return;
    recLang = voiceSettings().lang;
    if (whisperOn()) {
      isStarting = true;
      showMic("starting");
      recStream = await openMicrophone();
      isStarting = false;
    }
    if (recStream) {
      recChunks = [];
      try {
        recorder = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm")
          ? new MediaRecorder(recStream, { mimeType: "audio/webm" })
          : new MediaRecorder(recStream); // Safari: its own default, mp4/aac
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
        recorder.onstop = transcribeRecording;
        recorder.start();
      } catch (err) {
        console.warn("Recording unavailable:", err);
        recorder = null;
        recStream.getTracks().forEach((t) => t.stop());
        recStream = null;
      }
    }
    if (!recorder && !recognition) {
      showMic("");
      return;
    }
    if (recognition) {
      recognition.lang = recLang;
      recognition.continuous = !!recorder;
      listening = true;
      try { recognition.start(); } catch {}
    }
    isRecording = true;
    showMic("recording");
  }

  function stopVoice() {
    if (!isRecording) return;
    if (!recorder) {
      try { recognition.stop(); } catch {} // onend finishes
      return;
    }
    isRecording = false;
    isTranscribing = true;
    showMic("transcribing");
    if (recognition) { try { recognition.stop(); } catch {} }
    try { recorder.stop(); } catch { transcribeRecording(); }
  }

  async function transcribeRecording() {
    const type = (recorder && recorder.mimeType) || "audio/webm";
    if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
    let blob = new Blob(recChunks, { type });
    // iOS sometimes delivers the last data after stop: wait briefly for it.
    if (blob.size < 2000) {
      await new Promise((r) => setTimeout(r, 400));
      blob = new Blob(recChunks, { type });
    }
    let text = null;
    if (blob.size >= 2000) {
      try {
        const res = await fetch(`/api/voice/transcribe?language=${encodeURIComponent(recLang)}`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: blob,
        });
        if (res.status === 503 || res.status === 404) {
          try { sessionStorage.setItem(WHISPER_OFF, "1"); } catch {}
        }
        const data = await res.json().catch(() => null);
        if (res.ok && data && typeof data.text === "string") text = data.text.trim();
      } catch (err) {
        console.warn("Transcription failed, the browser's text stays:", err);
      }
    }
    listening = false;
    if (recognition) { try { recognition.abort(); } catch {} }
    if (text) setInputText(text);
    recorder = null;
    recChunks = [];
    isTranscribing = false;
    showMic("");
    if (!recognition && !whisperOn()) micBtn.style.display = "none";
    finishSpeech();
  }

  const VOICE_MESSAGES = typeof document !== "undefined" && document.querySelector?.('meta[name="embervy-voice"]')?.getAttribute("content") === "message";
  let vmRecorder = null;
  let vmStream = null;
  let vmChunks = [];
  let vmStart = 0;
  let vmBusy = false;

  async function startVoiceMessage() {
    if (vmBusy || vmRecorder) return;
    vmBusy = true;
    showMic("starting");
    vmStream = await openMicrophone();
    vmBusy = false;
    if (!vmStream) { showMic(""); return; }
    vmChunks = [];
    try {
      vmRecorder = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm")
        ? new MediaRecorder(vmStream, { mimeType: "audio/webm" })
        : new MediaRecorder(vmStream); // Safari: its own default, mp4/aac
    } catch (err) {
      console.warn("Recording unavailable:", err);
      vmStream.getTracks().forEach((t) => t.stop());
      vmStream = null;
      showMic("");
      return;
    }
    vmRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) vmChunks.push(e.data); };
    vmRecorder.onstop = uploadVoiceMessage;
    vmStart = Date.now();
    vmRecorder.start();
    showMic("recording");
  }

  function stopVoiceMessage() {
    if (!vmRecorder) return;
    showMic("transcribing");
    try { vmRecorder.stop(); } catch { uploadVoiceMessage(); }
  }

  async function uploadVoiceMessage() {
    const type = (vmRecorder && vmRecorder.mimeType) || "audio/webm";
    if (vmStream) { vmStream.getTracks().forEach((t) => t.stop()); vmStream = null; }
    let blob = new Blob(vmChunks, { type });
    // iOS sometimes delivers the last data after stop: wait briefly for it.
    if (blob.size < 2000) {
      await new Promise((r) => setTimeout(r, 400));
      blob = new Blob(vmChunks, { type });
    }
    vmRecorder = null;
    vmChunks = [];
    if (blob.size < 2000) { showMic(""); return; }
    const duration = Math.max(0, Math.round((Date.now() - vmStart) / 1000));
    const ext = type.includes("mp4") ? "m4a" : type.includes("webm") ? "webm" : "ogg";
    const form = new FormData();
    form.append("audio", blob, `voice.${ext}`);
    form.append("duration", String(duration));
    // All attempts of this recording share an id, including retries after a lost answer.
    const voiceId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    form.append("voice_id", voiceId);
    let sent = false;
    let why = "";
    for (let attempt = 0; attempt < 4 && !sent; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const res = await fetch("/api/voice", { method: "POST", body: form });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) {
          addMessage("user", "", new Date().toISOString(), data.id, null, data.audio_url, duration);
          sent = true;
        } else {
          why = `HTTP ${res.status}${data && data.error ? ` ${data.error}` : ""}`;
          if (res.status >= 400 && res.status < 500) break; // the server refused this recording; trying again will not help
        }
      } catch (err) {
        why = err && err.message ? err.message : String(err);
        console.warn(`Voice message attempt ${attempt + 1} failed:`, err);
      }
    }
    if (!sent) addMessage("user", t("chat.uploadFailed", { name: `voice (${why || "unknown"}, ${blob.size} bytes, ${type})` }), new Date().toISOString());
    showMic("");
  }

  micBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (VOICE_MESSAGES && canRecord) {
      if (vmRecorder) stopVoiceMessage();
      else startVoiceMessage();
      return;
    }
    if (isRecording) stopVoice();
    else startVoice();
  });

  if (!SpeechRecognitionAPI && !canRecord) {
    micBtn.style.display = "none";
  }

  let pingInterval = null;
  let backgroundPingInterval = null;
  let isBackground = false;

  function startPing() {
    stopPing();
    isBackground = false;
    fetch("/api/ping", { method: "POST" }).catch(() => {});
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => reg.getNotifications())
        .then((ns) => ns.forEach((n) => n.close()))
        .catch(() => {});
    }
    pingInterval = setInterval(() => {
      fetch("/api/ping", { method: "POST" }).catch(() => {});
    }, 3000);
  }

  function startBackgroundPing() {
    stopPing();
    isBackground = true;
    backgroundPingInterval = setInterval(() => {
      fetch("/api/ping", { method: "POST" }).catch(() => {});
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }
    }, 25000);
  }

  function stopPing() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (backgroundPingInterval) { clearInterval(backgroundPingInterval); backgroundPingInterval = null; }
  }

  // A reload for new texts or code waits while it would lose something: chosen
  // attachments, an upload or a voice recording.
  let uploadsInFlight = 0;
  let reloadWaitTimer = null;
  function reloadWouldLoseWork() {
    return pendingImages.length > 0 || uploadsInFlight > 0 || isRecording || isStarting || isTranscribing;
  }
  function reloadForVersion(version) {
    if (reloadWouldLoseWork()) {
      if (!reloadWaitTimer) {
        reloadWaitTimer = setInterval(() => {
          if (reloadWouldLoseWork()) return;
          clearInterval(reloadWaitTimer);
          reloadWaitTimer = null;
          reloadForVersion(version);
        }, 1000);
      }
      return;
    }
    sessionStorage.setItem("embervy-strings-reload", version);
    window.location.reload();
  }

  // A phone often restores the page from memory with old texts and code; compare
  // with the server and reload once when they differ.
  async function checkStringsVersion() {
    if (!I18N.version) return;
    try {
      const res = await fetch("/api/strings/version", { cache: "no-store" });
      if (!res.ok) return;
      const { version } = await res.json();
      if (!version || version === I18N.version) return;
      if (sessionStorage.getItem("embervy-strings-reload") === version) return;
      reloadForVersion(version);
    } catch { /* offline: try again next time */ }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkStringsVersion();
      startPing();
      checkWsAlive("visible");
      catchUpMessages();
    } else {
      startBackgroundPing();
    }
  });

  // After a network change the socket often stays half-open; reconnect at once instead of waiting for the heartbeat.
  window.addEventListener("online", () => {
    console.log("Network online — forcing WS reconnect");
    dropWs("network online", true);
    catchUpMessages();
  });
  window.addEventListener("offline", () => {
    console.log("Network offline");
    document.getElementById("status")?.classList.add("disconnected");
  });

  // iOS often restores the app from the back-forward cache or thaws it without a
  // visibilitychange event, so check the connection here too.
  const resumeFromSleep = (why) => {
    console.log(`resume (${why}) — checking WS + catch-up`);
    checkStringsVersion();
    if (document.visibilityState === "visible") startPing();
    checkWsAlive(why);
    catchUpMessages();
  };
  window.addEventListener("pageshow", (e) => { if (e.persisted) resumeFromSleep("pageshow"); });
  document.addEventListener("resume", () => resumeFromSleep("resume"));

  async function catchUpMessages() {
    refreshOpenApprovals();
    if (!lastSeenTs) return;
    try {
      const res = await fetch("/api/messages");
      const messages = await res.json();
      for (const msg of messages) {
        if (msg.ts > lastSeenTs) {
          addMessage(msg.role, msg.text, msg.ts, msg.id, msg.image_url, msg.audio_url, msg.duration, msg.reply_to, msg);
        }
      }
      // A reaction is broadcast once; one given while this device was away
      // (a phone asleep, a dropped socket) only shows if it is read again here.
      await loadStoredReactions();
      scrollToBottom();
    } catch {}
  }
  async function loadStoredReactions() {
    try {
      const res = await fetch("/api/reactions");
      const reactions = await res.json();
      for (const r of Array.isArray(reactions) ? reactions : []) addReactionToMessage(r.message_id, r.emoji, r.from);
    } catch {}
  }

  // The Brain menu: head, model, thinking level and restart, without slash commands or model ids.
  const brainMenuBtn = document.getElementById("brain-menu-btn");
  const brainMenuOverlay = document.getElementById("brain-menu-overlay");
  const brainMenuBody = document.getElementById("brain-menu-body");
  const brainMenuMeta = document.getElementById("brain-menu-meta");
  const brainMenuTitle = document.getElementById("brain-menu-title");
  const brainMenuCloseBtn = document.getElementById("brain-menu-close-btn");
  const brainMenuRefreshBtn = document.getElementById("brain-menu-refresh-btn");
  const BM_PANEL_WIDTH = 440;

  let brainMenuData = null;
  let brainMenuError = "";
  let brainMenuLoading = false;
  let brainMenuRefreshing = false;
  let brainMenuRefreshError = false;
  let brainMenuLoadSeq = 0;
  let brainMenuBusy = false;
  let brainMenuMsg = null;
  let bmSel = { head: null, family: null, model: null, effort: "" };
  let bmReloadTimer = null;
  const bmSignIns = { claude: { url: "", code: "", busy: false }, gpt: { url: "", code: "", busy: false } };

  function showBrainMenuButton(brain) {
    if (!brainMenuBtn) return;
    brainMenuBtn.hidden = !brain;
    if (!brain) {
      closeBrainMenu(false);
      brainMenuData = null;
      if (brainMenuRefreshBtn) brainMenuRefreshBtn.hidden = true;
    }
  }

  function bmEl(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function bmSection(title) {
    const section = bmEl("section", "brain-menu-section");
    section.append(bmEl("h3", "", title));
    return section;
  }
  function bmButton(text, onClick, cls) {
    const b = bmEl("button", cls || "", text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function bmField(label, control) {
    const row = bmEl("label", "bm-field");
    row.append(bmEl("span", "bm-field-label", label), control);
    return row;
  }
  function bmOption(value, text, { selected, disabled } = {}) {
    const o = bmEl("option", "", text);
    o.value = value;
    if (selected) o.selected = true;
    if (disabled) o.disabled = true;
    return o;
  }
  // iOS ticks the selected entry itself; what runs now is a suffix instead of
  // a second tick, so the tick always belongs to the selection.
  const bmMark = (current, text) => (current ? t("brainMenu.active", { name: text }) : text);
  function bmDepthText() {
    const b = (brainMenuData && brainMenuData.bridge) || {};
    const n = Number(b.count) || 0;
    if (b.mode === "sessions") return n === 1 ? t("brainMenu.depthSession") : t("brainMenu.depthSessions", { count: n });
    return n === 1 ? t("brainMenu.depthTurn") : t("brainMenu.depthTurns", { count: n });
  }

  const bmHead = (name) => (brainMenuData ? brainMenuData.heads.find((h) => h.name === name) || null : null);
  const bmFamily = (head, name) => (head ? head.families.find((f) => f.name === name) || null : null);
  function bmDefaultFamily(head) {
    return head ? (head.families.find((f) => f.current) || head.families[0] || null) : null;
  }
  function bmDefaultModel(family) {
    return family ? (family.models.find((m) => m.current) || family.models[0] || null) : null;
  }
  function bmSelectHead(name) {
    const head = bmHead(name);
    const family = bmDefaultFamily(head);
    const model = bmDefaultModel(family);
    bmSel = { head: head ? head.name : null, family: family ? family.name : null, model: model ? model.id : null, effort: "" };
  }
  function bmSelectFamily(name) {
    const family = bmFamily(bmHead(bmSel.head), name);
    const model = bmDefaultModel(family);
    bmSel = { ...bmSel, family: family ? family.name : null, model: model ? model.id : null, effort: "" };
  }
  function bmSelectedModel() {
    const family = bmFamily(bmHead(bmSel.head), bmSel.family);
    return family ? family.models.find((m) => m.id === bmSel.model) || null : null;
  }
  function bmResetSelection() {
    const heads = brainMenuData ? brainMenuData.heads : [];
    const current = heads.find((h) => h.current) || heads.find((h) => h.available) || null;
    bmSelectHead(current ? current.name : null);
  }

  function bmRestoreSelection() {
    const previous = bmSel;
    if (!bmHead(previous.head)) { bmResetSelection(); return; }
    bmSelectHead(previous.head);
    if (bmFamily(bmHead(previous.head), previous.family)) bmSelectFamily(previous.family);
    const family = bmFamily(bmHead(bmSel.head), bmSel.family);
    const model = family && family.models.find((m) => m.id === previous.model);
    if (model) bmSel = { ...bmSel, model: model.id, effort: model.effortLevels.includes(previous.effort) ? previous.effort : "" };
  }

  function renderBrainMenu() {
    if (!brainMenuBody) return;
    brainMenuBody.replaceChildren();
    brainMenuBody.classList.toggle("busy", brainMenuBusy);
    const d = brainMenuData;
    const restartOnly = d?.restartOnly === true;
    if (brainMenuRefreshBtn) {
      brainMenuRefreshBtn.hidden = !d || restartOnly || !brainMenuBtn || brainMenuBtn.hidden;
      brainMenuRefreshBtn.disabled = brainMenuLoading || brainMenuBusy;
      brainMenuRefreshBtn.classList.toggle("refreshing", brainMenuRefreshing);
      brainMenuRefreshBtn.setAttribute("aria-busy", String(brainMenuRefreshing));
    }
    const buttonKey = restartOnly ? "header.claudeCode" : "header.brain";
    const titleKey = restartOnly ? "brainMenu.claudeCode.title" : "brainMenu.title";
    if (brainMenuBtn) {
      brainMenuBtn.textContent = restartOnly ? t("header.claudeCode") : t("header.brain");
      brainMenuBtn.setAttribute("data-i18n", buttonKey);
      const hintKey = restartOnly ? "header.claudeCode.title" : "header.brain.title";
      brainMenuBtn.setAttribute("title", restartOnly ? t("header.claudeCode.title") : t("header.brain.title"));
      brainMenuBtn.setAttribute("data-i18n-title", hintKey);
    }
    if (brainMenuTitle) {
      brainMenuTitle.textContent = t(titleKey);
      brainMenuTitle.setAttribute("data-i18n", titleKey);
    }
    if (brainMenuMeta) {
      const now = d ? (restartOnly ? d.current.headLabel : t("brainMenu.current", { head: d.current.headLabel, model: d.current.modelLabel })) : "";
      brainMenuMeta.textContent = restartOnly && brainMenuLoading
        ? t("brainMenu.claudeCode.asking")
        : d ? (brainMenuLoading ? t("brainMenu.refreshing", { current: now }) : now)
        : (brainMenuLoading ? t("brainMenu.asking") : t("brainMenu.meta"));
    }
    if (brainMenuRefreshError) {
      const error = bmEl("p", "brain-menu-msg error", t("brainMenu.refreshFailed"));
      error.setAttribute("role", "status");
      brainMenuBody.append(error);
    }
    if (brainMenuMsg) brainMenuBody.append(bmEl("p", `brain-menu-msg${brainMenuMsg.error ? " error" : ""}`, brainMenuMsg.text));

    if (d) {
      const pickable = d.heads.filter((h) => h.available || h.current);
      const anyChoice = d.heads.some((h) => h.available && h.families.some((f) => f.models.some((m) => m.kind !== "current")));
      if (anyChoice) {
        const heads = bmSection(t("brainMenu.headsTitle"));
        const head = bmHead(bmSel.head);
        if (pickable.length > 1) {
          const select = bmEl("select", "bm-select");
          select.setAttribute("aria-label", t("brainMenu.head"));
          for (const h of d.heads) {
            // Why a head is missing (a key name, a login) is for the agent and the logs; the person sees "not set up".
            const text = h.available ? bmMark(h.current, h.label) : t("brainMenu.unavailable", { name: h.label });
            select.append(bmOption(h.name, text, { selected: h.name === bmSel.head, disabled: !h.available && !h.current }));
          }
          select.addEventListener("change", () => { brainMenuMsg = null; bmSelectHead(select.value); renderBrainMenu(); });
          heads.append(bmField(t("brainMenu.head"), select));
        }
        if (head && head.families.length > 1) {
          const select = bmEl("select", "bm-select");
          select.setAttribute("aria-label", t("brainMenu.family"));
          for (const f of head.families) select.append(bmOption(f.name, bmMark(f.current, f.name), { selected: f.name === bmSel.family }));
          select.addEventListener("change", () => { brainMenuMsg = null; bmSelectFamily(select.value); renderBrainMenu(); });
          heads.append(bmField(t("brainMenu.family"), select));
        }
        const family = bmFamily(head, bmSel.family);
        const models = family ? family.models : [];
        // The CLI labels its default alias "Default (recommended)": in a phone-wide
        // select only "recommended" fits beside the version and the active mark.
        const shortNote = (note) => (/^default \((.+)\)$/i.exec(note) || [])[1] || note;
        const optionText = (m) => bmMark(m.current, m.note ? `${m.version} · ${shortNote(m.note)}` : m.version);
        if (models.length > 1) {
          const select = bmEl("select", "bm-select");
          select.setAttribute("aria-label", t("brainMenu.version"));
          for (const m of models.filter((x) => !x.more)) select.append(bmOption(m.id, optionText(m), { selected: m.id === bmSel.model }));
          const more = models.filter((x) => x.more);
          if (more.length) {
            const group = document.createElement("optgroup");
            group.label = t("brainMenu.more");
            for (const m of more) group.append(bmOption(m.id, optionText(m), { selected: m.id === bmSel.model }));
            select.append(group);
          }
          select.addEventListener("change", () => { brainMenuMsg = null; bmSel = { ...bmSel, model: select.value, effort: "" }; renderBrainMenu(); });
          heads.append(bmField(t("brainMenu.version"), select));
        } else if (models.length === 1) {
          heads.append(bmField(t("brainMenu.version"), bmEl("span", "bm-value", optionText(models[0]))));
        }
        const picked = bmSelectedModel();
        // Validate effort against the destination model, without changing the running model.
        const targetLevels = picked && picked.kind === "head" && Array.isArray(picked.effortLevels) ? picked.effortLevels : [];
        if (targetLevels.length) {
          const select = bmEl("select", "bm-select");
          select.setAttribute("aria-label", t("brainMenu.effortThere"));
          select.append(bmOption("", t("brainMenu.effortRemembered"), { selected: !bmSel.effort }));
          for (const level of targetLevels) select.append(bmOption(level, level, { selected: level === bmSel.effort }));
          select.addEventListener("change", () => { bmSel = { ...bmSel, effort: select.value }; });
          heads.append(bmField(t("brainMenu.effortThere"), select), bmEl("p", "brain-menu-note", t("brainMenu.effortThereHint")));
        }
        const apply = bmButton(t("brainMenu.apply"), () => bmPickModel(head, picked), "bm-apply");
        apply.disabled = !head || !head.available || !picked || picked.kind === "current";
        const row = bmEl("div", "bm-apply-row");
        row.append(apply);
        heads.append(row);
        if (!d.claudeCatalog && d.heads.some((h) => h.name === "claude" && h.available)) {
          heads.append(bmEl("p", "brain-menu-note", t("brainMenu.noCatalog")));
        }
        brainMenuBody.append(heads);
      }
      for (const kind of ["claude", "gpt"]) {
        if (d.heads.some((h) => h.name === kind && !h.available && !h.current)) brainMenuBody.append(bmSignIn(kind));
      }
    } else if (!brainMenuLoading) {
      const heads = bmSection(t("brainMenu.headsTitle"));
      heads.append(bmEl("p", "brain-menu-note", brainMenuError || t("brainMenu.listFailed")));
      const row = bmEl("div", "bm-apply-row");
      row.append(bmButton(t("brainMenu.retry"), () => loadBrainMenu(), "bm-apply"));
      heads.append(row);
      brainMenuBody.append(heads);
    }

    if (d && !d.restartOnly) {
      const effort = bmSection(t("brainMenu.effort"));
      const cur = d.current;
      if (!cur.supportsEffort) {
        effort.append(bmEl("p", "brain-menu-note", t("brainMenu.effortNone")));
      } else {
        const select = bmEl("select", "bm-select bm-select-wide");
        select.setAttribute("aria-label", t("brainMenu.effort"));
        select.append(bmOption("default", t("brainMenu.effortDefault"), { selected: !cur.effort }));
        for (const level of cur.effortLevels) select.append(bmOption(level, level, { selected: level === cur.effort }));
        if (cur.effort && !cur.effortLevels.includes(cur.effort)) {
          select.append(bmOption(cur.effort, t("brainMenu.effortNotHere", { level: cur.effort }), { selected: true, disabled: true }));
        }
        select.addEventListener("change", () => bmSetEffort(select.value));
        effort.append(select);
        const applied = cur.effortApplied;
        if (applied && applied !== "n/a" && applied !== cur.effort) {
          effort.append(bmEl("p", "brain-menu-note", t("brainMenu.effortRunsAs", { chosen: cur.effort || t("brainMenu.effortDefault"), applied })));
        }
        effort.append(bmEl("p", "brain-menu-note", t("brainMenu.effortHint")));
      }
      brainMenuBody.append(effort);
    }

    const session = bmSection(t("brainMenu.session"));
    const actions = bmEl("div", "brain-menu-actions");
    actions.append(bmButton(t("brainMenu.restart"), bmRestart));
    session.append(actions);
    brainMenuBody.append(session);
  }

  // Keep the selection after an effort change so the next tap cannot land on Restart.
  const BM_SIGNIN = {
    claude: {
      route: "/api/brain/claude-signin", field: "code",
      title: () => t("brainMenu.claudeSignIn.title"), note: () => t("brainMenu.claudeSignIn.note"),
      start: () => t("brainMenu.claudeSignIn.start"), step2: () => t("brainMenu.claudeSignIn.step2"),
      placeholder: () => t("brainMenu.claudeSignIn.placeholder"), done: () => t("brainMenu.claudeSignIn.done"),
    },
    gpt: {
      route: "/api/brain/chatgpt-signin", field: "pasted",
      title: () => t("brainMenu.gptSignIn.title"), note: () => t("brainMenu.gptSignIn.note"),
      start: () => t("brainMenu.gptSignIn.start"), step2: () => t("brainMenu.gptSignIn.step2"),
      placeholder: () => t("brainMenu.gptSignIn.placeholder"), done: () => t("brainMenu.gptSignIn.done"),
    },
  };
  function bmSignIn(kind) {
    const k = BM_SIGNIN[kind];
    const st = bmSignIns[kind];
    const section = bmSection(k.title());
    section.append(bmEl("p", "brain-menu-note", k.note()));
    const start = bmButton(st.url ? t("brainMenu.claudeSignIn.again") : k.start(), async () => {
      bmSignIns[kind] = { url: "", code: "", busy: true };
      brainMenuMsg = { text: t("brainMenu.claudeSignIn.working") };
      renderBrainMenu();
      try {
        const res = await fetch(`${k.route}/start`, { method: "POST", credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.already) {
          brainMenuMsg = { text: k.done() };
          bmSignIns[kind] = { url: "", code: "", busy: false };
          return loadBrainMenu({ keepSelection: true });
        }
        bmSignIns[kind] = { url: data.url, code: "", busy: false };
        brainMenuMsg = null;
      } catch (e) {
        bmSignIns[kind] = { url: "", code: "", busy: false };
        brainMenuMsg = { text: e && e.message ? e.message : String(e), error: true };
      }
      renderBrainMenu();
    }, "bm-apply");
    start.disabled = st.busy;
    const row = bmEl("div", "bm-apply-row");
    row.append(start);
    section.append(row);
    if (st.url) {
      section.append(bmEl("p", "brain-menu-note", t("brainMenu.claudeSignIn.step1")));
      const link = bmEl("a", "bm-link", st.url);
      link.href = st.url;
      link.target = "_blank";
      link.rel = "noopener";
      section.append(link, bmEl("p", "brain-menu-note", k.step2()));
      const input = bmEl("input", "bm-input");
      input.placeholder = k.placeholder();
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = st.code;
      input.addEventListener("input", () => { bmSignIns[kind].code = input.value; });
      section.append(input);
      const finish = bmButton(t("brainMenu.claudeSignIn.finish"), async () => {
        bmSignIns[kind].busy = true;
        brainMenuMsg = { text: t("brainMenu.claudeSignIn.working") };
        renderBrainMenu();
        try {
          const res = await fetch(`${k.route}/code`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [k.field]: bmSignIns[kind].code }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          bmSignIns[kind] = { url: "", code: "", busy: false };
          brainMenuMsg = { text: k.done() };
          return loadBrainMenu({ keepSelection: true });
        } catch (e) {
          bmSignIns[kind].busy = false;
          brainMenuMsg = { text: e && e.message ? e.message : String(e), error: true };
        }
        renderBrainMenu();
      }, "bm-apply");
      finish.disabled = st.busy;
      const finishRow = bmEl("div", "bm-apply-row");
      finishRow.append(finish);
      section.append(finishRow);
    }
    return section;
  }

  async function bmRefresh() {
    if (brainMenuLoading || brainMenuBusy || !brainMenuData || brainMenuData.restartOnly) return;
    clearTimeout(bmReloadTimer);
    return loadBrainMenu({ refresh: true, keepSelection: true });
  }

  async function loadBrainMenu(opts = {}) {
    const seq = ++brainMenuLoadSeq;
    brainMenuLoading = true;
    brainMenuRefreshing = opts.refresh === true;
    brainMenuRefreshError = false;
    brainMenuError = "";
    renderBrainMenu();
    try {
      const res = await fetch(opts.refresh ? "/api/brain/heads?refresh=1" : "/api/brain/heads", { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (seq !== brainMenuLoadSeq) return;
      if (res.status === 404 && data.error === "not brain") { showBrainMenuButton(false); return; }
      if (!res.ok || !data.current || !Array.isArray(data.heads)) throw new Error(data.error || `HTTP ${res.status}`);
      brainMenuData = data;
      showBrainMenuButton(true);
      claudeAuthEnabled = data.restartOnly === true || data.heads.some(h => h.name === "claude" && (h.available || h.current));
      if (opts.keepSelection) bmRestoreSelection();
      else bmResetSelection();
    } catch (e) {
      if (seq === brainMenuLoadSeq) {
        brainMenuError = e && e.message ? e.message : String(e);
        brainMenuRefreshError = opts.refresh === true;
      }
    } finally {
      if (seq === brainMenuLoadSeq) {
        brainMenuLoading = false;
        brainMenuRefreshing = false;
        renderBrainMenu();
      }
    }
  }

  function bmReloadSoon(opts) {
    clearTimeout(bmReloadTimer);
    bmReloadTimer = setTimeout(() => {
      if (brainMenuOverlay && !brainMenuOverlay.hidden) loadBrainMenu(opts);
    }, 3000);
  }

  async function bmSend(body) {
    const res = await fetch("/api/brain/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Menu actions are controls, not messages typed by the person.
    return data;
  }

  async function bmPickModel(head, m) {
    if (brainMenuBusy || !head || !m || m.kind === "current") return;
    const target = t("brainMenu.current", { head: head.label, model: m.version });
    const move = m.kind === "head";
    const effort = move && bmSel.effort ? bmSel.effort : "";
    const question = [
      t("brainMenu.confirmSwitch", { target }),
      move ? t("brainMenu.whatHead", { head: head.label, depth: bmDepthText() }) : t("brainMenu.whatModel"),
      effort ? t("brainMenu.withEffort", { level: effort }) : "",
    ].filter(Boolean).join("\n\n");
    if (!window.confirm(question)) return;
    brainMenuBusy = true;
    brainMenuMsg = { text: t("brainMenu.sending", { target }) };
    renderBrainMenu();
    try {
      await bmSend({ action: "switch", head: head.name, model: m.id, move, ...(effort ? { effort } : {}) });
      brainMenuMsg = { text: move ? t("brainMenu.sentHead", { target }) : t("brainMenu.sentModel", { target }) };
      // Back to what runs: "Switch" greys out, so a second tap cannot send it twice.
      bmResetSelection();
      if (!move) bmReloadSoon();
    } catch (e) {
      brainMenuMsg = { text: t("brainMenu.switchFailed", { error: e && e.message ? e.message : String(e) }), error: true };
    }
    brainMenuBusy = false;
    renderBrainMenu();
  }

  async function bmSetEffort(level) {
    if (brainMenuBusy) return;
    brainMenuBusy = true;
    renderBrainMenu();
    try {
      await bmSend({ action: "effort", level });
      if (brainMenuData) brainMenuData.current.effort = level === "default" ? null : level;
      brainMenuMsg = { text: t("brainMenu.effortSent", { level: level === "default" ? t("brainMenu.effortDefault") : level }) };
      bmReloadSoon({ keepSelection: true });
    } catch (e) {
      brainMenuMsg = { text: t("brainMenu.effortFailed", { error: e && e.message ? e.message : String(e) }), error: true };
    }
    brainMenuBusy = false;
    renderBrainMenu();
  }

  async function bmRestart() {
    if (brainMenuBusy) return;
    if (!window.confirm(t("brainMenu.confirmRestart", { depth: bmDepthText() }))) return;
    brainMenuBusy = true;
    renderBrainMenu();
    try {
      await bmSend({ action: "restart" });
      brainMenuBusy = false;
      closeBrainMenu();
    } catch (e) {
      brainMenuBusy = false;
      brainMenuMsg = { text: t("brainMenu.restartFailed", { error: e && e.message ? e.message : String(e) }), error: true };
      renderBrainMenu();
    }
  }

  function openBrainMenu() {
    if (!brainMenuOverlay) return;
    const r = brainMenuBtn ? brainMenuBtn.getBoundingClientRect() : null;
    const panel = brainMenuOverlay.querySelector(".brain-menu-panel");
    if (r) {
      const width = Math.min(BM_PANEL_WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
      brainMenuOverlay.style.paddingTop = `${Math.round(r.bottom + 6)}px`;
      brainMenuOverlay.style.paddingLeft = `${left}px`;
      if (panel) {
        panel.style.width = `${width}px`;
        panel.style.maxHeight = `${Math.max(240, Math.round(window.innerHeight - r.bottom - 14))}px`;
      }
    }
    brainMenuOverlay.hidden = false;
    if (brainMenuBtn) brainMenuBtn.setAttribute("aria-expanded", "true");
    brainMenuMsg = null;
    renderBrainMenu();
    loadBrainMenu();
  }
  function closeBrainMenu(focus = true) {
    if (!brainMenuOverlay || brainMenuOverlay.hidden) return;
    clearTimeout(bmReloadTimer);
    brainMenuOverlay.hidden = true;
    if (brainMenuBtn) {
      brainMenuBtn.setAttribute("aria-expanded", "false");
      if (focus) brainMenuBtn.focus();
    }
  }
  if (brainMenuBtn) brainMenuBtn.addEventListener("click", openBrainMenu);
  if (brainMenuCloseBtn) brainMenuCloseBtn.addEventListener("click", () => closeBrainMenu());
  if (brainMenuRefreshBtn) brainMenuRefreshBtn.addEventListener("click", bmRefresh);
  if (brainMenuOverlay) {
    brainMenuOverlay.addEventListener("click", (event) => {
      if (event.target === brainMenuOverlay) closeBrainMenu();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && brainMenuOverlay && !brainMenuOverlay.hidden) closeBrainMenu();
  });

  const modelToggle = document.getElementById("model-toggle");

  async function syncModel() {
    if (!modelToggle) return;
    try {
      const res = await fetch("/api/internal/model", { credentials: "include" });
      const data = await res.json();
      if (res.ok && data.ok && data.switchable === false) {
        modelToggle.hidden = true;
        showBrainMenuButton(data.substrate === "brain");
        if (data.substrate === "brain") await loadBrainMenu();
        return;
      }
      if (res.ok && data.ok && data.model) {
        const has = [...modelToggle.options].some(o => o.value === data.model);
        if (has) modelToggle.value = data.model;
      }
      if (res.ok && data.ok) await loadBrainMenu();
      // Claude Code's model capability enables auth even without a Claude menu head.
      claudeAuthEnabled = res.ok && data.ok === true;
    } catch (e) {
      console.error("model sync failed:", e);
    }
  }

  if (modelToggle) {
    syncModel();
    modelToggle.addEventListener("change", async () => {
      const next = modelToggle.value;
      modelToggle.classList.add("switching");
      try {
        const res = await fetch("/api/internal/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ model: next }),
        });
        const data = await res.json();
        console.log("model switch:", res.status, data);
        if (!res.ok || !data.ok) {
          await syncModel();
        }
      } catch (e) {
        console.error("model switch failed:", e);
        await syncModel();
      }
      modelToggle.classList.remove("switching");
    });
  }

  const claudeAuthEl = id => document.getElementById(`claude-auth-${id}`);
  let claudeAuthBusy = false;
  let claudeAuthRetry = false;
  function renderClaudeAuth(data) {
    const banner = claudeAuthEl("banner");
    if (!banner) return;
    banner.hidden = data.expired !== true;
    claudeAuthEl("text").textContent = data.kept ? t("claudeAuth.kept") : t("claudeAuth.resend");
    claudeAuthEl("start").textContent = claudeAuthRetry ? t("brainMenu.claudeSignIn.again") : t("claudeAuth.again");
    claudeAuthEl("guide").textContent = t("brainMenu.claudeSignIn.step2");
    claudeAuthEl("link").textContent = t("claudeAuth.open");
    claudeAuthEl("code").placeholder = t("brainMenu.claudeSignIn.placeholder");
    claudeAuthEl("code").setAttribute("aria-label", t("brainMenu.claudeSignIn.placeholder"));
    claudeAuthEl("finish").textContent = t("brainMenu.claudeSignIn.finish");
    if (banner.hidden) {
      claudeAuthRetry = false;
      claudeAuthEl("start").hidden = false;
      claudeAuthEl("form").hidden = true;
      claudeAuthEl("code").value = "";
      claudeAuthEl("link").removeAttribute("href");
      claudeAuthEl("result").textContent = "";
    }
  }
  async function pollClaudeAuth() {
    if (!claudeAuthEnabled) return;
    try {
      const res = await fetch("/api/claude-auth", { credentials: "include", cache: "no-store" });
      if (res.ok) renderClaudeAuth(await res.json());
    } catch { /* Keep the last observation while the connection is unavailable. */ }
  }
  async function sendClaudeAuth(step) {
    if (claudeAuthBusy) return;
    claudeAuthBusy = true;
    claudeAuthRetry = true;
    const code = claudeAuthEl("code").value;
    // The code belongs only to this request, never to chat or persistent client state.
    claudeAuthEl("code").value = "";
    claudeAuthEl("start").disabled = claudeAuthEl("finish").disabled = true;
    claudeAuthEl("result").textContent = t("brainMenu.claudeSignIn.working");
    try {
      const res = await fetch(`/api/brain/claude-signin/${step}`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...(step === "code" ? { body: JSON.stringify({ code }) } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        claudeAuthEl("form").hidden = true;
        claudeAuthEl("result").textContent = data.error || t("claudeAuth.error.finishFailed");
        return;
      }
      if (step === "start" && data.url) {
        claudeAuthEl("link").href = data.url;
        claudeAuthEl("form").hidden = false;
        // The form may already be open, so a new link needs words to be seen at all.
        claudeAuthEl("result").textContent = t("claudeAuth.linkReady");
      } else {
        claudeAuthEl("form").hidden = true;
        claudeAuthEl("start").hidden = true;
        claudeAuthEl("result").textContent = t("claudeAuth.done");
        await pollClaudeAuth();
      }
    } catch {
      claudeAuthEl("result").textContent = t("claudeAuth.error.finishFailed");
    } finally {
      claudeAuthBusy = false;
      claudeAuthEl("start").textContent = t("brainMenu.claudeSignIn.again");
      claudeAuthEl("start").disabled = claudeAuthEl("finish").disabled = false;
    }
  }
  if (claudeAuthEl("start")) claudeAuthEl("start").addEventListener("click", () => sendClaudeAuth("start"));
  if (claudeAuthEl("finish")) claudeAuthEl("finish").addEventListener("click", () => sendClaudeAuth("code"));
  async function init() {
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("/sw.js");
        navigator.serviceWorker.addEventListener("message", (e) => {
          if (e.data && e.data.type === "reload") {
            window.location.reload();
          }
        });
      } catch (err) {
        console.error("SW registration failed:", err);
      }
    }

    pollClaudeAuth();
    setInterval(pollClaudeAuth, 3000);
    await loadHistory();
    connectWs();
    checkStringsVersion();
    setupPush();
    startPing();
    setupScrollButton();
    inputEl.focus();
  }

  init();
})();
