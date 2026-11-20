# App appearance and clock

## House settings and device settings

Settings → Title controls the shared name and font. Background mode and photo are also shared. These four fields (`titleText`, `titleFont`, `bgMode`, `bgPhoto`) belong to the house, so a phone and laptop see the same identity and image.

All colors and opacity remain in each device's `embervy-appearance` local storage: `bgColor`, `userColor`, `userAlpha`, `agentColor`, `agentAlpha`, `titleColor`, `textColor`, `accentColor`, `onAccentColor`, `borderColor`. Features, speech language and automatic speech sending keep their existing behavior. Installer defaults (`embervyHouseFeatures`) are not changed.

**Use the house look** clears only device color/opacity overrides. It does not delete the shared version. A palette preset changes device colors without switching off a shared photo. The agent's `public/style.css` and `public/index.html` are still the underlying house design; missing or empty shared title/font values leave that design in effect. Existing healing of legacy appearance snapshots remains active.

## Loading and adoption

Opening the app first renders local choices, including the last-known house fields, without waiting for the network. It then reads the shared version. A successful read replaces only shared fields and remembers them locally; a failed metadata or image read leaves everything as it was and shows no error. Photo bytes are retained locally for offline drawing, not put in the service worker cache. A device-only `bgPhotoVersion` hash (also learned from a successful save) avoids downloading the image again unless its version changes or the local image is missing.

When there is no house version, a device with legacy shared fields offers them through a conditional adoption route. The server checks and commits without yielding: of concurrent device requests, only the first can establish the version. An existing empty object is a version, not permission to adopt again. A device without shared choices does not initialize the house merely by opening it.

Settings loads the house fields before enabling edits to them. Apply explicitly replaces the shared version and saves device fields locally. Device storage is checked before the network save. A rejected house write keeps previous appearance and device choices, shows an error, and permits retry. A server-side terminal preference change made as part of Apply is rolled back best-effort if the appearance write fails. As with other network settings, a connection lost after a successful server commit can leave its acknowledgement unknown; reopening reads the authoritative version.

## Storage and API

The app data directory is `EMBERVY_APP_DATA_DIR`, defaulting to `Claude/app/data`, beside terminal preferences and other app state:

- `house-look.json`: sparse shared metadata. `bgPhoto`, if present, names an image file, never a data URL.
- `house-look-photo-<sha256>`: the separate image. Its type is detected from its first bytes.

Files are written privately (`0600`) through temporary files and rename. Immutable image data is committed before metadata; the JSON rename is the visible commit point. An unsuccessful metadata commit cannot corrupt the old referenced image. Superseded images are removed after commit. An abrupt process exit can leave an unreferenced image or temp file; these can be removed after checking the current JSON reference. The app uses one server process per data directory, as for the existing app settings. Back up JSON and the referenced image together.

All routes require the human session cookie (no agent bearer or local trust bypass), enforce the app's origin allowlist, and answer `Cache-Control: private, no-store`, including errors. The service worker only caches explicitly listed static assets, never these routes.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/api/house-look` | `{ "look": null }` before initialization; otherwise a sparse shared object under `look`. Photo values are private versioned photo URLs. |
| POST | `/api/house-look` | Replace with the submitted shared fields, including `{}`. Return the resulting `look`. |
| POST | `/api/house-look/migrate` | Initialize only if no version exists; otherwise return the existing `look`, unchanged. |
| GET | `/api/house-look/photo?v=<sha256>` | Current image bytes and detected MIME type; unknown or superseded versions return 404. |

Writes accept only the four shared fields, rejecting device fields and unknown keys. `titleText` is at most 24 UTF-16 code units with no control characters. `titleFont` may be empty or a custom CSS font list of at most 200 characters using Unicode letters, digits, spaces, commas, hyphens, underscores and paired straight quotes, with no control characters or CSS escape syntax; it is applied only via `style.fontFamily`. `bgMode` is `color`, `photo` or the legacy `default`. `bgPhoto` is absent, empty or a base64 data URL with JPEG, PNG, GIF or WebP magic bytes; SVG and arbitrary URLs are not accepted. The decoded limit is 5 MiB, generous headroom above the client's 1600px, quality-0.85 JPEG target. A streaming body limit also bounds encoded uploads before JSON parsing.

## One clock

`/feature-defaults.js` continues to provide installer feature choices and additionally sets `embervyHouseTimeZone` from the existing server `houseTimeZone()`. Chat, terminal logs, Kept and doctor mute hints use two-digit hours/minutes and `hourCycle: "h23"`; midnight is `00:00`, never `24:00` or AM/PM. Browser dates remain localized, including the house's calendar day at midnight. Invalid or absent house zones fall back to the browser's device zone (and to the server's local zone for terminal logs). Number formatting is unchanged.

Only English is currently shipped in `strings/`. The shared/device scope hints and save error are keys in `strings/en.json`, available to all installed language overlays through the existing English fallback. Local translations belong in `strings.local.json`.

## Device review

Automated tests execute browser scripts with test DOMs, not a real browser. Before release, check a phone and laptop with different palettes/time zones: first open and offline reopen, house-winning synchronization, competing legacy adoption, photo chooser/preview and large-photo quota behavior, failed saves and retry, reset/presets retaining the house photo, custom HTML/CSS fallbacks, all clock locations around midnight, and service-worker updates. Do not infer browser/PWA behavior solely from script tests.
