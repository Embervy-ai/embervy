// Centralize storage migration so the pages only read and write current keys.
// No stored name needs moving today; a future rename adds its pair to the lists below.

(function moveLegacyStorage() {
  // Ordered legacy keys migrate to current names; the first available value wins.
  const KEYS = [];
  // Fields inside the stored appearance (the agent's bubble): old → current.
  const APPEARANCE_FIELDS = [];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  try {
    for (const [old, current] of KEYS) {
      const value = localStorage.getItem(old);
      if (value === null) continue;
      if (localStorage.getItem(current) === null) localStorage.setItem(current, value);
      localStorage.removeItem(old);
    }
    const raw = localStorage.getItem("embervy-appearance");
    if (!raw) return;
    const look = JSON.parse(raw);
    if (!look || typeof look !== "object" || Array.isArray(look)) return;
    let changed = false;
    for (const [old, current] of APPEARANCE_FIELDS) {
      if (!own(look, old)) continue;
      if (!own(look, current)) look[current] = look[old];
      delete look[old];
      changed = true;
    }
    if (changed) localStorage.setItem("embervy-appearance", JSON.stringify(look));
  } catch { /* storage unavailable or unreadable: nothing to move */ }
})();
