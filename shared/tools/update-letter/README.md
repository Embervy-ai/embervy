# Update letters

Build a letter from a Git repository using Bun:

```sh
bun shared/tools/update-letter/build.ts \
  --from <base-commit> --to <target-commit> \
  --house brain --out /tmp/update-letter \
  --home-default /opt/embervy
```

Use `--house claude` for a Claude house. `--only-existing <file>` accepts one repository-relative path per line from a house measurement. Unmeasured base files are excluded; genuinely new upstream files remain included. The builder reads committed blobs, not working-tree contents, and resolves the range to full commit IDs.

The directory contains `files.tar.gz`, `manifest.txt`, `known.txt`, executable `update.sh`, and `UPDATE.md`. Fill in **What changes and why** before delivery. Keep the directory intact; it can be moved both before applying and before restoring.

For each changed path still present upstream, the archive carries the committed new bytes at `<path>` and, if the path existed at `--from` and its base passes the private-name filter, the committed base bytes at `<path>.embervy-base`. New upstream paths and withheld bases have no base payload. The manifest remains `old-sha256 new-sha256 path`: the old hash authenticates the base, `ABSENT` denotes a new upstream path, and `DELETED` denotes an upstream deletion. Deleted paths have no payload and remain untouched at the house. `known.txt` identifies previously shipped versions that may be safely replaced. The builder refuses repository paths colliding with either sidecar name, including unchanged paths.

## Private old-name filtering

The builder reads only the private patterns from `~/.config/embervy-checks/old-names-private.txt`, or the path selected by `EMBERVY_PRIVATE_OLD_NAMES`. Keep this file outside the repository. Its format matches the installer's `old-names.txt`: `LABEL<TAB>PATTERN[<TAB>FLAGS]`, with blank lines and lines starting with `#` ignored. Patterns are regular expressions applied directly to each UTF-8 line of the base content, as in the package checker, or to the deleted repository-relative path, without adding word boundaries. Flags default to `iu`; only `iu` and case-sensitive `u` are accepted. Case-specific Unicode classes under `i`, invalid regexes, malformed entries and lists containing no patterns stop the build. Diagnostics do not print private labels or patterns.

A matching old version is omitted from `files.tar.gz`; the new version and manifest hashes stay unchanged. For a locally edited file without this base, the house uses the existing manual-merge fallback: it keeps the resident file and writes the new version beside it, with an explicitly reported empty base placeholder. A resident file matching the old hash or another known shipped hash can still be replaced normally.

A matching deleted path is omitted from both the manifest and `UPDATE.md`. Instead, `UPDATE.md` gives only the number of unlisted withdrawn files and says they may remain in the house. This count respects `--only-existing`. Other deletions remain listed and untouched as before. When the private file is missing, the builder prints one warning line and builds the same unfiltered contents as without these rules. Private patterns and their file are never copied into the letter. This filter covers old base contents and deleted paths; it is not a substitute for checking the new upstream contents and paths before delivery.

## At the house

Never apply without the person's word. The generated **Who applies it**
section is specific to `--house`: on Claude Code the person runs
`! bash update.sh apply` in the agent's terminal because the agent's own
permission check may block deployment; the agent runs `check` before and
after and then the doctor. On Brain, the agent applies on the person's word,
with the same checks before and after and the doctor afterwards.

```sh
bash update.sh check --home /path/to/house
bash update.sh apply --home /path/to/house
bash update.sh take <path> --home /path/to/house
bash update.sh back --home /path/to/house
```

The letter's `DEFAULT_HOME` is the house it was built for (`--home-default`), made absolute by the builder. Every verb uses it unless an explicit `--home <dir>` selects another house. The option may appear before or after the verb and its operand. `EMBERVY_HOME` never selects the home: a set value differing from the built home (including an empty value) stops the script before reading any letter artifact, journal, or house unless `--home` was given. An equal or unset value is fine. Each invocation starts with `house: <absolute dir> (built for this house)` or `house: <absolute dir> (--home)`; a routing refusal prints the built-home header and one error line naming both folders and asking for `--home <dir>` if the other folder is intended. The home must already exist. Use the same house and an account able to preserve its file owners and permissions for apply and back. Runtime requirements are Bash 4 or newer and GNU coreutils, findutils, and tar; Bun and Git are not needed at the house. GNU diffutils `diff3` is optional, detected with `command -v`: without it the update uses sidecars rather than automatic merging.

- `check` is read-only and reports `replace`, `already`, `kept`, `new`, `merge-clean`, `diverged`, or `deleted-upstream`. It validates the payload, tries three-way merges only in a temporary directory, and cleans temporary files on exit. Neither the house nor the letter is modified. `already` means byte-identical to the update. `kept` means your file differs from the update, but merging the update into it changes nothing: your file already contains this update. `merge-clean` means your changes and the update can be combined without conflict.
- `apply` validates all supplied new and base hashes and destinations, backs up the complete touch set, and then writes. A previous `backup` blocks another apply. Old bytes that still match are replaced; new paths are created; `already` and `kept` files are untouched, with no sidecars written for them. A file the resident changed is never written: a clean three-way merge (`diff3 -m -E` with house, base, new) goes beside it as `<path>.embervy-merged` and is reported as `merged`. The `-E` option accepts identical overlapping changes; a successful merge whose SHA-256 equals the house file's hash is `kept`. Deleted-upstream paths remain untouched.
- `take <path>` adopts a `.embervy-merged` sidecar by the resident's own decision. The version before the first take is recorded in the same backup, so `back` restores it.
- Conflicting overlapping edits, a NUL byte in any input, missing `diff3`, missing base, or a merge-tool error mean `diverged`: your file remains untouched. `<path>.embervy-new` contains the update and `<path>.embervy-base` contains its base. Run `diff -u <path>.embervy-base <path>.embervy-new` to see exactly what the update changes; carry that into your version. Both sidecars are in the touch set. `back` removes newly created sidecars or restores any pre-existing ones. When no base is available, including a new upstream path that collides with your file, the base sidecar is an explicitly reported empty placeholder, not an original version; the instruction warns you instead of claiming an exact upstream diff.
- Check summaries count `replace`, `already`, `kept`, `new`, `merge-clean`, `diverged`, and `deleted-upstream`. Apply summaries use `merged` instead of `merge-clean`, counting the `.embervy-merged` sidecars written.
- When `sw.js` or `index.html` is `merge-clean` or `diverged`, check and apply remind you to keep your asset versions and service-worker cache number above the letter's, with a house suffix, so phones fetch the new files. After changing `app.js` or `style.css`, raise its `?v=` number in `index.html` and `sw.js` and the `CACHE_NAME` in `sw.js`, adding a house suffix such as `?v=115-h1` and `embervy-v30-h1`. Increase the suffix for later house changes; letters only raise the plain number, without a house suffix.
- A missing house file is `new` even when the base contained it; `check` says "missing in house, will be added", and `back` removes it again.
- New directories inherit their parent's owner and mode, independently of the caller's umask.
- Existing destination owners and modes are retained. New files inherit metadata from a regular file with the same extension in the same directory, excluding update temporary files and sidecars; without a same-extension neighbour they use the directory owner and group and mode `0644`. Ownership is set before permissions to preserve special mode bits.
- Saved files live in the single `backup/files.tar` archive, not a searchable copy of the source tree. Test runners cannot discover the archived test filenames. `take` appends its saved originals to the same archive. Only the new archive layout is read by this script.
- `back` restores backed-up bytes, owners, modes, and symlinks, removes newly created files and empty created folders, and retains the journal as `backup.after-back` (or a numbered variant). The journal is bound to the canonical house path, not the letter's location. It is also usable after a partial apply failure.

Keep independent writers stopped while applying or restoring. Back restores the recorded pre-apply state, so edits made to touched destinations after applying would be undone. Do not modify the trusted letter artifacts or recovery journal. Unsafe symlink/non-directory parents and directory sidecar destinations are refused before any house writes. `check` still classifies unsafe-parent paths as divergent. Changed upstream symlinks are rejected by the builder rather than silently converted to regular files. Newline, tab, and noncanonical repository paths are unsupported. File-content hashes determine the update state; executable-bit-only Git changes do not alter house metadata.

## File-set verification boundary

The selector excludes runtime folders, secrets, resident-owned root documents, the installer subtree, and `Codex/`. Both Brain and Claude letters retain both harness folders because both reach installed houses. This change does not re-audit selector parity with the installer; it preserves the existing builder selection rules.

## Tests

```sh
bun test ./shared/tools/update-letter/
```

For a single test file, use `bun test ./shared/tools/x.test.ts`. Without the leading `./`, Bun treats the argument as a name filter, not an explicit path, and may discover other matching files.

Tests use only temporary repositories, houses and private lists with an invented word; they do not read the builder's real private list. If the runner provides `mawk` but no `awk` command, the tests temporarily expose that real POSIX awk implementation under the `awk` name and remove the alias afterwards; no command is stubbed out. Private-name tests cover parser parity (default and explicit flags, regexes, Unicode restrictions and errors), default-home and environment-override lookup, withheld bases, artifact scans, neutral deletion counts, measurement filtering, missing-file compatibility, and check/apply/back with edited, unchanged and missing resident files. The existing tests cover two-house routing for every verb (unset, equal, conflicting and explicitly overridden environment values), first-line house announcements, backup binding, archived test invisibility under a real Bun name filter, explicit test paths throughout `docs/`, all states, clean merges and exact rollback, overlapping changes, missing `diff3`, NUL bytes in each merge input without invoking `diff3`, missing and corrupt bases, both sidecar collisions, check immutability and temporary cleanup, neighbour metadata, special modes, full listing restoration, existing sidecars and symlinks, repeated-apply refusal, moved letters and backups, partial write failure, corrupt payloads, custom home quoting, and empty letters. Non-default ownership is tested when the runner has the required capability; otherwise UID/GID preservation is still compared for the runner's existing owners.
