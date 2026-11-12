// Edits appearance and feature settings for the app.

const t = window.embervyI18n ? window.embervyI18n.t : (key) => key;
const KEY = "embervy-appearance"; 

function hexToRgba(hex, pct) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${(pct / 100).toFixed(2)})`;
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
function toneOf(source) {
  try {
    const small = document.createElement("canvas");
    small.width = 16; small.height = 16;
    const g = small.getContext("2d");
    g.drawImage(source, 0, 0, 16, 16);
    const px = g.getImageData(0, 0, 16, 16).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) { sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; }
    return "#" + sum.map((v) => Math.round(v / (px.length / 4)).toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}
function suggestLook(bg, own) {
  const text = readableOn(bg);
  const base = isHex(own) ? own : mixHex(bg, text, 0.5);
  let accent = base;
  for (let step = 1; contrastRatio(accent, bg) < 4.5 && step <= 10; step++) accent = mixHex(base, text, step / 10);
  return { text, accent, onAccent: readableOn(accent), border: mixHex(bg, text, 0.25) };
}

const SPEECH_LANGUAGES = ["ar", "da", "de", "el", "en-GB", "en-US", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "ru", "sv", "tr", "uk", "zh-CN"];

function fillSpeechLanguages(select, chosen) {
  const appLanguage = (window.embervyI18n && window.embervyI18n.language) || "en";
  let names = null;
  try { names = new Intl.DisplayNames([appLanguage], { type: "language" }); } catch {}
  const label = (tag) => { try { return (names && names.of(tag)) || tag; } catch { return tag; } };
  const tags = SPEECH_LANGUAGES.includes(chosen) || !chosen ? SPEECH_LANGUAGES : [...SPEECH_LANGUAGES, chosen];
  tags
    .map((tag) => ({ tag, name: label(tag) }))
    .sort((a, b) => a.name.localeCompare(b.name, appLanguage))
    .forEach(({ tag, name }) => {
      const option = document.createElement("option");
      option.value = tag;
      option.textContent = name;
      select.appendChild(option);
    });
  select.value = chosen || "";
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
function houseDefaults() {
  const houseStyle = getComputedStyle(document.documentElement);
  const houseColor = (name, fallback) => cssColor(houseStyle.getPropertyValue(name).trim(), fallback);
  const user = houseColor("--bg-user", "#E8E0D8");
  const agent = houseColor("--bg-agent", "#FFFFFF");
  return {
    bgColor: houseColor("--bg", "#F5F0EB").color,
    userColor: user.color, userAlpha: user.alpha,
    agentColor: agent.color, agentAlpha: agent.alpha,
    titleColor: houseColor("--accent", "#887052").color,
    textColor: houseColor("--text", "#2C2C2C").color,
    accentColor: houseColor("--accent", "#887052").color,
    onAccentColor: houseColor("--on-accent", "#FFFFFF").color,
    borderColor: houseColor("--border", "#E0D8D0").color,
  };
}
const DEFAULTS = {
  ...houseDefaults(),
  bgMode: "color",
  bgPhoto: "",
  titleText: "Embervy",
  titleFont: "",
  speechLang: "",            
  speechSend: true,          
  // The installer's choices are the defaults; a saved device choice wins.
  features: { doctor: true, voice: true, whisper: true, games: true, notes: true, terminal_panel: true, terminal_input: false, photos: true, files: true, push: true, ...(window.embervyHouseFeatures || {}) },
};

function load() {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { return {}; }
  let stored;
  try { stored = healAppearance(JSON.parse(raw || "{}")); } catch { return {}; }
  // A blocked write must not prevent the healed choices from being used this time.
  if (raw && JSON.stringify(stored) !== raw) {
    try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch {}
  }
  return stored;
}

const choices = load();
const s = { ...DEFAULTS, ...choices, features: { ...DEFAULTS.features, ...(choices.features || {}) } };
const manualLook = new Set(["textColor", "accentColor", "onAccentColor", "borderColor"].filter((key) => isHex(choices[key])));
let bgPhotoData = s.bgPhoto;
let suggestFromStoredPhoto = s.bgMode === "photo" && !!s.bgPhoto && !isHex(choices.bgColor);
if (isHex(choices.bgColor) || isHex(choices.userColor)) {
  const look = suggestLook(s.bgColor, s.userColor);
  const values = { textColor: look.text, accentColor: look.accent, onAccentColor: look.onAccent, borderColor: look.border };
  for (const [key, value] of Object.entries(values)) if (!manualLook.has(key)) s[key] = value;
}
if (manualLook.has("accentColor") && !manualLook.has("onAccentColor")) s.onAccentColor = readableOn(s.accentColor);
const initial = { ...s };
const APPEARANCE_FIELDS = ["bgMode", "bgColor", "bgPhoto", "userColor", "userAlpha", "agentColor", "agentAlpha", "titleText", "titleFont", "titleColor", "textColor", "accentColor", "onAccentColor", "borderColor"];
function phoneChoices(values) {
  const out = { ...choices, appearanceVersion: 1 };
  const same = (a, b) => isHex(a) && isHex(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const key of APPEARANCE_FIELDS) {
    const palette = Object.hasOwn(LOOK_FIELDS, key);
    if (palette && !manualLook.has(key)) { delete out[key]; continue; }
    if (!palette && same(values[key], initial[key])) continue;
    delete out[key];
    if (!same(values[key], DEFAULTS[key])) out[key] = values[key];
  }
  out.features = values.features;
  out.speechLang = values.speechLang;
  out.speechSend = values.speechSend;
  return out;
}

const $ = (id) => document.getElementById(id);

$("bg-color").value = s.bgColor;
// Cached HTML may lack these fields even when the script has them.
const LOOK_FIELDS = { textColor: "text-color", accentColor: "accent-color", onAccentColor: "on-accent-color", borderColor: "border-color" };
for (const [key, id] of Object.entries(LOOK_FIELDS)) { const input = $(id); if (input) input.value = s[key]; }
function lookValue(key) { const input = $(LOOK_FIELDS[key]); return input && isHex(input.value) ? input.value : s[key]; }
function setLook(look, replace = true) {
  if (replace) manualLook.clear();
  const values = { textColor: look.text, accentColor: look.accent, onAccentColor: look.onAccent, borderColor: look.border };
  if (!replace && manualLook.has("accentColor")) values.onAccentColor = readableOn(lookValue("accentColor"));
  for (const [key, value] of Object.entries(values)) {
    if (!replace && manualLook.has(key)) continue;
    s[key] = value; const input = $(LOOK_FIELDS[key]); if (input) input.value = value;
  }
  updateReadability();
}
for (const [key, id] of Object.entries(LOOK_FIELDS)) {
  $(id)?.addEventListener("input", () => {
    manualLook.add(key);
    if (key === "accentColor" && !manualLook.has("onAccentColor")) {
      s.onAccentColor = readableOn(lookValue("accentColor"));
      const input = $(LOOK_FIELDS.onAccentColor); if (input) input.value = s.onAccentColor;
    }
  });
}
for (const id of ["bg-color", "user-color"]) {
  $(id)?.addEventListener("input", () => setLook(suggestLook($("bg-color").value, $("user-color").value), false));
}
function updateReadability() {
  const show = (id, a, b, line) => {
    const el = $(id);
    if (!el || !isHex(a) || !isHex(b)) return;
    const ratio = contrastRatio(a, b);
    el.textContent = line({ ratio: ratio.toFixed(1), verdict: ratio >= 4.5 ? t("settings.contrast.ok") : t("settings.contrast.low") });
    el.classList.toggle("warn", ratio < 4.5);
  };
  show("text-contrast", lookValue("textColor"), $("bg-color").value, (v) => t("settings.contrast.text", v));
  show("accent-contrast", lookValue("onAccentColor"), lookValue("accentColor"), (v) => t("settings.contrast.button", v));
}
for (const id of [...Object.values(LOOK_FIELDS), "bg-color"]) $(id)?.addEventListener("input", updateReadability);
updateReadability();
$("user-color").value = s.userColor;
$("user-alpha").value = s.userAlpha;
$("user-alpha-val").textContent = s.userAlpha + "%";
$("agent-color").value = s.agentColor;
$("agent-alpha").value = s.agentAlpha;
$("agent-alpha-val").textContent = s.agentAlpha + "%";
$("title-text").value = s.titleText;
$("title-font").value = s.titleFont;
$("title-color").value = s.titleColor;
$("feature-doctor").checked = s.features.doctor;
$("feature-voice").checked = s.features.voice;
$("feature-whisper").checked = s.features.whisper;
fillSpeechLanguages($("speech-lang"), s.speechLang);
$("speech-send").checked = s.speechSend !== false;
$("feature-games").checked = s.features.games;
$("feature-notes").checked = s.features.notes !== false;
$("feature-terminal-panel").checked = s.features.terminal_panel !== false;
$("feature-terminal-input").checked = s.features.terminal_input === true;
$("feature-photos").checked = s.features.photos !== false;
$("feature-files").checked = s.features.files !== false;
$("feature-push").checked = s.features.push !== false;

const SERVICE_WORKER_READY_TIMEOUT_MS = 3000;

function serviceWorkerReadyWithinTimeout() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("service worker readiness timed out")), SERVICE_WORKER_READY_TIMEOUT_MS)),
  ]);
}

function pushVapidKeyBytes(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function applyPushFeature(enabled) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const registration = await serviceWorkerReadyWithinTimeout();
    const subscription = await registration.pushManager.getSubscription();
    if (!enabled) {
      if (subscription) await subscription.unsubscribe();
      return;
    }
    if (Notification.permission !== "granted" || subscription) return;
    const response = await fetch("/api/push/vapid-key");
    const { key } = await response.json();
    const created = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushVapidKeyBytes(key),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(created.toJSON()),
    });
  } catch {}
}

function refreshAgentLabel() {
  const name = ($("title-text").value || "").trim();
  $("agent-label").textContent = name ? t("settings.bubbles.yoursColorNamed", { name }) : t("settings.bubbles.yoursColor");
}
refreshAgentLabel();
$("title-text").addEventListener("input", refreshAgentLabel);

const THEME_PRESETS = [
  { id: "midnight", nameKey: "settings.scheme.midnight", bg: "#0B1228", user: "#D4A948", agent: "#5A91DC", title: "#7FB2F0" },
  { id: "slate",    nameKey: "settings.scheme.slate",    bg: "#151A21", user: "#9FB4CC", agent: "#6E8BA8", title: "#AFC4DC" },
  { id: "carbon",   nameKey: "settings.scheme.carbon",   bg: "#121316", user: "#B0B4BA", agent: "#7C828A", title: "#C6CAD0" },
  { id: "forest",   nameKey: "settings.scheme.forest",   bg: "#0E1A15", user: "#C9A961", agent: "#5F9C78", title: "#96C7AA" },
  { id: "plum",     nameKey: "settings.scheme.plum",     bg: "#171021", user: "#C98BC4", agent: "#8A6BAC", title: "#C1A4DC" },
  { id: "ember",    nameKey: "settings.scheme.ember",    bg: "#1A1310", user: "#E0925F", agent: "#A9664A", title: "#DCA487" },
  { id: "paper",    nameKey: "settings.scheme.paper",    bg: "#FAF7F2", user: "#DED3C3", agent: "#E2E8ED", title: "#65513D" },
  { id: "sand",     nameKey: "settings.scheme.sand",     bg: "#EFE4D2", user: "#D9C5A9", agent: "#DCE5DA", title: "#65513D" },
];

function markActivePreset() {
  const bg = ($("bg-color").value || "").toLowerCase();
  const user = ($("user-color").value || "").toLowerCase();
  const agent = ($("agent-color").value || "").toLowerCase();
  document.querySelectorAll(".theme-preset").forEach((el) => {
    const p = THEME_PRESETS.find((x) => x.id === el.dataset.preset);
    const hit = !!p && p.bg.toLowerCase() === bg && p.user.toLowerCase() === user && p.agent.toLowerCase() === agent;
    el.classList.toggle("active", hit);
  });
}

function applyPreset(preset) {
  $("bg-color").value = preset.bg;
  $("user-color").value = preset.user;
  $("agent-color").value = preset.agent;
  $("title-color").value = preset.title;
  setLook(suggestLook(preset.bg, preset.user));
  setBgMode("color");
  markActivePreset();
}

(function renderPresets() {
  const host = $("theme-presets");
  if (!host) return;
  for (const preset of THEME_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-preset";
    btn.dataset.preset = preset.id;
    const name = t(preset.nameKey);
    btn.setAttribute("aria-label", t("settings.scheme.presetLabel", { name }));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    for (const colour of [preset.bg, preset.user, preset.agent]) {
      const chip = document.createElement("i");
      chip.style.background = colour;
      swatch.appendChild(chip);
    }
    const label = document.createElement("span");
    label.textContent = name;
    btn.append(swatch, label);
    btn.addEventListener("click", () => applyPreset(preset));
    host.appendChild(btn);
  }
  markActivePreset();
})();

function setBgMode(mode) {
  document.querySelectorAll("#bg-mode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  const label = $("bg-color-label");
  if (label) label.textContent = mode === "photo" ? t("settings.background.colorAroundPhoto") : t("settings.background.color");
  $("bg-photo-row").classList.toggle("hidden", mode !== "photo");
  s.bgMode = mode;
}
setBgMode(s.bgMode);
document.querySelectorAll("#bg-mode button").forEach((b) =>
  b.addEventListener("click", () => setBgMode(b.dataset.mode)));

$("bg-photo-hint").textContent = bgPhotoData
  ? t("settings.background.custom") : t("settings.background.default");

function showPhotoPreview(unsaved) {
  const preview = $("bg-photo-preview");
  if (!preview) return;
  if (!bgPhotoData) { preview.hidden = true; preview.removeAttribute("src"); return; }
  preview.onload = () => {
    preview.hidden = false;
    if (suggestFromStoredPhoto) {
      suggestFromStoredPhoto = false;
      const tone = toneOf(preview);
      if (tone) {
        $("bg-color").value = tone;
        setLook(suggestLook(tone, $("user-color").value), false);
        $("bg-photo-hint").textContent = `${t("settings.background.customUnsaved")} ${t("settings.background.suggested")}`;
        return;
      }
    }
    if (!unsaved) $("bg-photo-hint").textContent = t("settings.background.customSize", { width: preview.naturalWidth, height: preview.naturalHeight });
  };
  preview.onerror = () => {
    preview.hidden = true;
    $("bg-photo-hint").textContent = t("settings.background.broken");
  };
  preview.src = bgPhotoData;
}
showPhotoPreview(false);

$("user-alpha").addEventListener("input", (e) =>
  $("user-alpha-val").textContent = e.target.value + "%");
$("agent-alpha").addEventListener("input", (e) =>
  $("agent-alpha-val").textContent = e.target.value + "%");

$("bg-photo-btn").addEventListener("click", () => $("bg-photo-input").click());
$("bg-photo-input").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    // Camera photos can exceed localStorage capacity, so resize them before saving.
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        const data = canvas.toDataURL("image/jpeg", 0.85);
        // A canvas the browser could not draw answers "data:," instead of throwing.
        if (!/^data:image\/jpeg;base64,./.test(data)) throw new Error("empty canvas");
        bgPhotoData = data;
        $("bg-photo-hint").textContent = `${t("settings.background.customUnsaved")} ${t("settings.background.suggested")}`;
        showPhotoPreview(true);
        suggestFromStoredPhoto = false;
        const tone = toneOf(canvas);
        if (tone) {
          $("bg-color").value = tone;
          setLook(suggestLook(tone, $("user-color").value));
        }
      } catch {
        $("bg-photo-hint").textContent = t("settings.background.processError");
      }
    };
    img.onerror = () => {
      $("bg-photo-hint").textContent = t("settings.background.readError");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

$("save-btn").addEventListener("click", async () => {
  const out = {
    bgMode: s.bgMode,
    bgColor: $("bg-color").value,
    bgPhoto: bgPhotoData || "",
    textColor: lookValue("textColor"),
    accentColor: lookValue("accentColor"),
    onAccentColor: lookValue("onAccentColor"),
    borderColor: lookValue("borderColor"),
    userColor: $("user-color").value,
    userAlpha: +$("user-alpha").value,
    agentColor: $("agent-color").value,
    agentAlpha: +$("agent-alpha").value,
    titleText: ($("title-text").value || "").trim() || "Embervy",
    titleFont: $("title-font").value,
    titleColor: $("title-color").value,
    speechLang: $("speech-lang").value,
    speechSend: $("speech-send").checked,
    features: {
      doctor: $("feature-doctor").checked,
      voice: $("feature-voice").checked,
      whisper: $("feature-whisper").checked,
      games: $("feature-games").checked,
      notes: $("feature-notes").checked,
      terminal_panel: $("feature-terminal-panel").checked,
      terminal_input: $("feature-terminal-input").checked,
      photos: $("feature-photos").checked,
      files: $("feature-files").checked,
      push: $("feature-push").checked,
    },
  };
  let previous;
  try {
    previous = localStorage.getItem(KEY);
    // Check local storage first so a quota failure cannot leave the server preference changed.
    localStorage.setItem(KEY, JSON.stringify(phoneChoices(out)));
  } catch {
    alert(t("settings.saveFailed"));
    return;
  }
  try {
    const response = await fetch("/api/terminal/settings", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: out.features.terminal_panel, input_enabled: out.features.terminal_input }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    // Keep UI and server state aligned when the server rejects the change.
    try {
      if (previous === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, previous);
    } catch {}
    alert(t("settings.terminalFailed"));
    return;
  }
  await applyPushFeature(out.features.push);
  window.location.href = "/";
});


$("house-look-btn")?.addEventListener("click", () => {
  try {
    const stored = load();
    for (const key of APPEARANCE_FIELDS) delete stored[key];
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    alert(t("settings.saveFailed"));
    return;
  }
  window.location.href = "/";
});

(async function setupApprovals() {
  const input = $("approval-level"), status = $("approval-settings-status");
  if (!input) return;
  let state;
  function render() {
    input.value = state.level;
    $("approval-patterns").classList.toggle("hidden", state.level !== "important");
    $("approval-extra").textContent = state.extra.length ? t("approvalSettings.extra", { labels: state.extra.map(p => p.label).join("; ") }) : "";
  }
  try {
    const response = await fetch("/api/approval-settings", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error();
    state = await response.json();
    if (state.available === false) return;
    $("approval-settings-section").classList.remove("hidden");
    render();
    input.disabled = false;
  } catch {
    $("approval-settings-section").classList.remove("hidden");
    status.textContent = t("approvalSettings.loadFailed");
    return;
  }
  input.addEventListener("change", async () => {
    input.disabled = true;
    try {
      const response = await fetch("/api/approval-settings", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: input.value }) });
      if (!response.ok) throw new Error();
      state = await response.json();
      status.textContent = "";
    } catch { status.textContent = t("approvalSettings.saveFailed"); }
    render();
    input.disabled = false;
  });
})();

// Consent is server-owned, not part of per-device appearance or the Apply button.
(async function setupMailboxWriting() {
  const section = $("mailbox-write-section");
  if (!section) return;
  const input = $("mailbox-write-enabled"), hint = $("mailbox-write-hint");
  let enabled = false;
  try {
    const response = await fetch("/api/mailbox-write/settings", { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    const state = await response.json();
    if (!state.configured) return;
    enabled = state.enabled === true;
    input.checked = enabled;
    hint.textContent = t("mailboxWrite.hint");
    section.classList.remove("hidden");
  } catch { return; }
  input.addEventListener("change", async () => {
    input.disabled = true;
    try {
      const response = await fetch("/api/mailbox-write/settings", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: input.checked }),
      });
      if (!response.ok) throw new Error("refused");
      enabled = (await response.json()).enabled === true;
      hint.textContent = t("mailboxWrite.hint");
    } catch { hint.textContent = t("mailboxWrite.saveFailed"); }
    input.checked = enabled;
    input.disabled = false;
  });
})();

(async function setupModelSwitcher() {
  const section = document.getElementById("model-section");
  if (!section) return;
  let info;
  try { info = await (await fetch("/api/gpt-model", { credentials: "include" })).json(); } catch { return; }
  if (info && info.substrate === "brain") {
    section.classList.remove("hidden");
    const field = section.querySelector(".field");
    if (field) field.classList.add("hidden");
    document.getElementById("model-hint").textContent = t("settings.model.brain");
    return;
  }
  if (!info || info.substrate !== "gpt") return;
  section.classList.remove("hidden");
  const hint = document.getElementById("model-hint");
  const buttons = [...document.querySelectorAll("#model-buttons button")];
  function mark(model) {
    buttons.forEach((b) => b.classList.toggle("active", model === `gpt-5.6-${b.dataset.model}`));
  }
  mark(info.model);
  hint.textContent = info.model ? t("settings.model.current", { model: info.model }) : t("settings.model.unreachable");
  buttons.forEach((b) => b.addEventListener("click", async () => {
    hint.textContent = t("settings.model.switching", { model: b.dataset.model });
    try {
      await fetch("/api/message", { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `/model ${b.dataset.model}` }) });
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const now = await (await fetch("/api/gpt-model", { credentials: "include" })).json();
        if (now.model === `gpt-5.6-${b.dataset.model}`) { mark(now.model); hint.textContent = t("settings.model.current", { model: now.model }); return; }
      }
      hint.textContent = t("settings.model.unconfirmed");
    } catch { hint.textContent = t("settings.model.failed"); }
  }));
})();
