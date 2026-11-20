/* Shared fields travel separately from device colors and feature preferences. */
(function (root) {
  "use strict";
  const fields = ["titleText", "titleFont", "bgMode", "bgPhoto"];
  function pick(value) {
    const out = {};
    for (const key of fields) if (Object.hasOwn(value, key)) out[key] = value[key];
    return out;
  }
  function merge(local, shared) {
    const out = { ...local };
    for (const key of fields) delete out[key];
    // This hash belongs only to the device copy, never to the wire fields.
    delete out.bgPhotoVersion;
    return { ...out, ...pick(shared), ...(shared.bgPhotoVersion ? { bgPhotoVersion: shared.bgPhotoVersion } : {}) };
  }
  async function request(path, value) {
    const response = await root.fetch(path, {
      credentials: "include", cache: "no-store",
      ...(value === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pick(value)) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Object.hasOwn(data, "look") || (data.look !== null && (typeof data.look !== "object" || Array.isArray(data.look)))) throw new Error("Invalid house appearance");
    return data.look;
  }
  function photoVersion(look) {
    const match = /^\/api\/house-look\/photo\?v=([a-f0-9]{64})$/.exec(look.bgPhoto);
    if (!match) throw new Error("Invalid house photo address");
    return match[1];
  }
  async function materialize(look, local) {
    if (!look.bgPhoto) return pick(look);
    const bgPhotoVersion = photoVersion(look);
    // Keep an offline copy in device storage, never in a service-worker cache.
    if (local.bgPhotoVersion === bgPhotoVersion && /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(local.bgPhoto)) {
      return { ...pick(look), bgPhoto: local.bgPhoto, bgPhotoVersion };
    }
    const response = await root.fetch(look.bgPhoto, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { ...pick(look), bgPhoto: `data:${response.headers.get("content-type")};base64,${btoa(binary)}`, bgPhotoVersion };
  }
  async function sync(local, migrate = false) {
    let look = await request("/api/house-look");
    if (look === null && migrate && Object.keys(pick(local)).length) look = await request("/api/house-look/migrate", local);
    return look === null ? local : merge(local, await materialize(look, local));
  }
  async function save(value) {
    // The POST acknowledgement identifies the bytes we just sent; no image read is needed.
    const look = await request("/api/house-look", value);
    if (look === null) throw new Error("Invalid house appearance");
    return merge(value, { ...pick(look), ...(look.bgPhoto ? { bgPhoto: value.bgPhoto, bgPhotoVersion: photoVersion(look) } : {}) });
  }
  root.embervyHouseLook = { fields, pick, merge, sync, save };
})(typeof window !== "undefined" ? window : globalThis);
