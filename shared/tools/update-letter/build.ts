#!/usr/bin/env bun
// Builds portable update packages with backups and manual conflict resolution.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readPrivateOldNames } from "./private-names";

type House = "brain" | "claude";
type Options = { from: string; to: string; house: House; out: string; homeDefault: string; onlyExisting?: string };
type Entry = { path: string; oldHash: string; newHash: string };

function usage(): never {
  throw new Error("usage: bun build.ts --from <commit> --to <commit> --house brain|claude --out <dir> [--home-default <dir>] [--only-existing <file>]");
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--from", "--to", "--house", "--out", "--home-default", "--only-existing"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown option: ${key}`);
  const house = values.get("--house");
  if (house !== "brain" && house !== "claude") usage();
  const from = values.get("--from");
  const to = values.get("--to");
  const out = values.get("--out");
  if (!from || !to || !out) usage();
  return { from, to, house, out, homeDefault: values.get("--home-default") ?? "/opt/embervy", onlyExisting: values.get("--only-existing") };
}

function run(args: string[], cwd: string): Uint8Array {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function text(args: string[], cwd: string): string {
  return new TextDecoder().decode(run(args, cwd)).trim();
}

function tree(commit: string, cwd: string): Map<string, string> {
  const raw = run(["git", "ls-tree", "-r", "-z", commit], cwd).toString();
  return new Map(raw.split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    return [record.slice(separator + 1), record.slice(0, 6)];
  }));
}

// Updates must not carry secrets, runtime state or locally owned documents.
const SKIP_SEGMENTS = new Set([".git", ".claude", "state", "logs", "incoming", "data", "notes", "node_modules", ".bun", ".e2e-run", "keys", "import-staging"]);
const SKIP_NAMES = new Set([".env", ".mcp.json", "chatgpt-auth.json", "strings.local.json"]);
const SKIP_ROOT = new Set(["CLAUDE.md", "EMBERVY.md", "HOUSE.md", "INFRASTRUCTURE.md", "HANDBOOK.md"]);
export function carriedByHouse(path: string, _house: House): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((part) => SKIP_SEGMENTS.has(part))) return false;
  if (SKIP_NAMES.has(name) || name.endsWith(".env")) return false;
  if (parts.length === 1 && SKIP_ROOT.has(name)) return false;
  if (path.startsWith("shared/tools/installer/") || path.startsWith("Codex/")) return false;
  // Add-ons ship on their own; in a house this folder holds the ones its person installed.
  if (path.startsWith("shared/extensions/")) return false;
  return true;
}

function safePath(path: string): boolean {
  return path.length > 0 && path === path.trim() && !path.startsWith("/")
    && path.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)
    && !/[\n\r\t]/.test(path);
}

function blob(commit: string, path: string, cwd: string): Uint8Array {
  return run(["git", "cat-file", "blob", `${commit}:${path}`], cwd);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellSingle(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderScript(homeDefault: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\\n' "$*" >&2; exit 1; }
DEFAULT_HOME=${shellSingle(homeDefault)}
HOME_DIR="$DEFAULT_HOME"
HOME_SOURCE='built for this house'
EXPLICIT_HOME=0
ARGS=()
while (( $# )); do
  case "$1" in
    --home)
      (( $# >= 2 )) && [[ -n "$2" ]] || fail "--home requires a directory"
      [[ "$EXPLICIT_HOME" == 0 ]] || fail "--home may only be given once"
      HOME_DIR="$2"; HOME_SOURCE='--home'; EXPLICIT_HOME=1; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "\${ARGS[@]}"
# Reject ambient routing before reading the letter, the journal, or either house.
if [[ "$EXPLICIT_HOME" == 0 && "\${EMBERVY_HOME+x}" == x && "$EMBERVY_HOME" != "$HOME_DIR" ]]; then
  printf 'house: %s (%s)\\n' "$HOME_DIR" "$HOME_SOURCE"
  fail "EMBERVY_HOME=$EMBERVY_HOME differs from chosen house $HOME_DIR; pass --home <dir> if the other folder is the house meant."
fi
HOME_DIR="$(CDPATH= cd -- "$HOME_DIR" && pwd -P)"
printf 'house: %s (%s)\\n' "$HOME_DIR" "$HOME_SOURCE"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
MANIFEST="$SCRIPT_DIR/manifest.txt"
ARCHIVE="$SCRIPT_DIR/files.tar.gz"
BACKUP="$SCRIPT_DIR/backup"
hash_file() { sha256sum < "$1" | awk '{print $1}'; }
declare -A KNOWN=()
if [[ -f "$SCRIPT_DIR/known.txt" ]]; then
  while read -r known_hash known_path; do [[ -n "\${known_path:-}" ]] && KNOWN["$known_path|$known_hash"]=1; done < "$SCRIPT_DIR/known.txt"
fi
exists_any() { [[ -e "$1" || -L "$1" ]]; }
validate_path() {
  local p="$1" part
  local -a parts
  [[ -n "$p" && "$p" != /* ]] || fail "unsafe manifest path: $p"
  IFS='/' read -r -a parts <<< "$p"
  for part in "\${parts[@]}"; do [[ "$part" != '..' && -n "$part" ]] || fail "unsafe manifest path: $p"; done
}
validate_parent_chain() {
  local p="$1" current="$HOME_DIR" part
  local -a parts
  IFS='/' read -r -a parts <<< "$(dirname -- "$p")"
  for part in "\${parts[@]}"; do
    [[ "$part" == '.' ]] && continue
    current="$current/$part"
    [[ ! -L "$current" ]] || fail "refusing symlink parent: $current"
    [[ ! -e "$current" || -d "$current" ]] || fail "parent is not a directory: $current"
  done
}
binary_file() {
  local chunk
  # Bash stops a delimiter read at the first NUL without needing another utility.
  IFS= read -r -d '' chunk < "$1"
}
trial_merge() {
  local path="$1" base="$PAYLOAD/$1.embervy-base" file
  [[ -f "$base" && ! -L "$base" ]] || return 1
  command -v diff3 >/dev/null 2>&1 || return 1
  for file in "$HOME_DIR/$path" "$base" "$PAYLOAD/$path"; do
    if binary_file "$file"; then return 1; fi
  done
  mkdir -p -- "$MERGES/$(dirname -- "$path")"
  # Identical overlapping changes are already included, not conflicts.
  diff3 -m -E -- "$HOME_DIR/$path" "$base" "$PAYLOAD/$path" > "$MERGES/$path" 2>/dev/null
}
prepare_payload() {
  WORK="$(mktemp -d)"
  trap '[[ -z "\${WRITE_TEMP:-}" ]] || rm -f -- "$WRITE_TEMP"; rm -rf -- "$WORK"' EXIT
  PAYLOAD="$WORK/payload"; MERGES="$WORK/merged"; PLAN="$WORK/plan"
  mkdir -- "$PAYLOAD" "$MERGES"
  [[ -f "$ARCHIVE" ]] || fail "files.tar.gz is missing"
  tar -xzf "$ARCHIVE" -C "$PAYLOAD"
  local old new path base
  # Authenticate all supplied bytes before any trial merge or house write.
  while read -r old new path; do
    [[ -n "\${path:-}" ]] || continue
    validate_path "$path"
    [[ "$new" != DELETED ]] || continue
    [[ -f "$PAYLOAD/$path" && ! -L "$PAYLOAD/$path" ]] || fail "payload missing: $path"
    [[ "$(hash_file "$PAYLOAD/$path")" == "$new" ]] || fail "payload hash mismatch: $path"
    base="$PAYLOAD/$path.embervy-base"
    if exists_any "$base"; then
      [[ "$old" != ABSENT && -f "$base" && ! -L "$base" ]] || fail "invalid base payload: $path"
      [[ "$(hash_file "$base")" == "$old" ]] || fail "base hash mismatch: $path"
    fi
  done < "$MANIFEST"
}
state_of() {
  local old="$1" new="$2" path="$3" current
  local full="$HOME_DIR/$path"
  if [[ "$new" == DELETED ]]; then printf 'deleted-upstream'; return; fi
  # A check must classify unsafe parents without following them or aborting.
  if ! (validate_parent_chain "$path") 2>/dev/null; then printf 'diverged'; return; fi
  if exists_any "$full"; then
    if [[ -L "$full" || ! -f "$full" ]]; then printf 'diverged'; return; fi
    current="$(hash_file "$full")"
    [[ "$current" == "$new" ]] && { printf 'already'; return; }
    [[ "$old" != ABSENT && "$current" == "$old" ]] && { printf 'replace'; return; }
    [[ -n "\${KNOWN[$path|$current]:-}" ]] && { printf 'replace'; return; }
    if [[ "$old" != ABSENT ]] && trial_merge "$path"; then
      if [[ "$(hash_file "$MERGES/$path")" == "$current" ]]; then printf 'kept'; else printf 'merge-clean'; fi
    else
      printf 'diverged'
    fi
  else
    printf 'new'
  fi
}
ensure_parent() {
  local path="$1" rel="" part parent
  local -a parts
  parent="$(dirname -- "$path")"
  [[ "$parent" == '.' ]] && return
  IFS='/' read -r -a parts <<< "$parent"
  for part in "\${parts[@]}"; do
    rel="\${rel:+$rel/}$part"
    if ! exists_any "$HOME_DIR/$rel"; then
      printf '%s\\n' "$rel" >> "$BACKUP/created-dirs.txt"
      parent="$(dirname -- "$HOME_DIR/$rel")"
      mkdir -- "$HOME_DIR/$rel"
      # Inherit the directory policy rather than the applying shell's umask.
      chown --reference="$parent" "$HOME_DIR/$rel"
      chmod --reference="$parent" "$HOME_DIR/$rel"
    fi
  done
}
record_touch() {
  local path="$1"
  local full="$HOME_DIR/$path"
  if exists_any "$full"; then
    # An archive hides saved test filenames from recursive test discovery.
    tar --append --file="$BACKUP/files.tar" -C "$HOME_DIR" -- "$path"
  else
    printf '%s\\n' "$path" >> "$BACKUP/absent.txt"
  fi
  # Only fully archived paths enter the restore journal if saving fails partway through.
  printf '%s\\n' "$path" >> "$BACKUP/touched.txt"
}
install_payload() {
  local path="$1" source="\${2:-$1}" reference="" temp name extension candidate candidate_extension
  # Separate dependent assignments because Bash expands local arguments first.
  local full="$HOME_DIR/$path" payload="\${3:-$PAYLOAD/$source}"
  [[ -f "$payload" && ! -L "$payload" ]] || fail "payload missing: $path"
  ensure_parent "$path"
  temp="$(mktemp --tmpdir="$(dirname -- "$full")" .embervy-update.XXXXXX)"
  WRITE_TEMP="$temp"
  cat -- "$payload" > "$temp"
  if exists_any "$full" && [[ ! -L "$full" ]]; then
    reference="$full"
  else
    name="$(basename -- "$full")"
    extension=""
    [[ "$name" != *.* ]] || extension="\${name##*.}"
    while IFS= read -r -d '' candidate; do
      name="$(basename -- "$candidate")"
      candidate_extension=""
      [[ "$name" != *.* ]] || candidate_extension="\${name##*.}"
      if [[ "$candidate_extension" == "$extension" ]]; then
        reference="$candidate"
        break
      fi
    done < <(find "$(dirname -- "$full")" -maxdepth 1 -type f ! -name "$(basename -- "$full")" ! -name '*.embervy-new' ! -name '*.embervy-base' ! -name '*.embervy-merged' ! -name '.embervy-update.*' -print0)
  fi
  if [[ -n "$reference" ]]; then
    # Ownership changes can clear special mode bits, so restore the mode last.
    chown --reference="$reference" "$temp"
    chmod --reference="$reference" "$temp"
  else
    chmod 0644 "$temp"
    chown --reference="$(dirname -- "$full")" "$temp"
  fi
  mv -fT -- "$temp" "$full"
  WRITE_TEMP=""
}
version_hint() {
  local state="$1" path="$2"
  [[ "$state" == merge-clean || "$state" == diverged ]] || return 0
  case "$path" in
    sw.js|*/sw.js|index.html|*/index.html)
      printf "versions %s — keep your asset versions and service-worker cache number above the letter's, with a house suffix (for example ?v=115-h1 and embervy-v30-h1), so phones fetch the new files.\\n" "$path" ;;
  esac
}
check_letter() {
  prepare_payload
  local old new path state
  local -A counts=([replace]=0 [already]=0 [kept]=0 [new]=0 [merge-clean]=0 [diverged]=0 [deleted-upstream]=0)
  while read -r old new path; do
    [[ -n "\${path:-}" ]] || continue
    validate_path "$path"
    state="$(state_of "$old" "$new" "$path")"
    counts[$state]=$((counts[$state]+1))
    if [[ "$state" == new && "$old" != ABSENT ]]; then
      printf '%s %s — missing in house, will be added\\n' "$state" "$path"
    elif [[ "$state" == kept ]]; then
      printf '%s %s — your file already contains this update\\n' "$state" "$path"
    elif [[ "$state" == merge-clean ]]; then
      printf '%s %s — untouched; merge will lie at %s.embervy-merged for you to decide\\n' "$state" "$path" "$path"
    elif [[ "$state" == diverged ]]; then
      printf '%s %s — untouched; update will lie at %s.embervy-new for you to decide\\n' "$state" "$path" "$path"
    elif [[ "$state" == replace || "$state" == new ]]; then
      printf '%s %s — will be applied\\n' "$state" "$path"
    else
      printf '%s %s\\n' "$state" "$path"
    fi
    version_hint "$state" "$path"
  done < "$MANIFEST"
  printf 'only replace and new are applied; merge-clean and diverged leave sidecars for your decision.\\n'
  printf 'summary: replace=%d already=%d kept=%d new=%d merge-clean=%d diverged=%d deleted-upstream=%d\\n' "\${counts[replace]}" "\${counts[already]}" "\${counts[kept]}" "\${counts[new]}" "\${counts[merge-clean]}" "\${counts[diverged]}" "\${counts[deleted-upstream]}"
}
apply_letter() {
  ! exists_any "$BACKUP" || fail "backup already exists; run back before applying again"
  prepare_payload
  local old new path state side target
  local replace=0 already=0 kept=0 fresh=0 merged=0 diverged=0 deleted=0
  local -a destinations
  local -A targets=()
  : > "$PLAN"
  # Validate every payload and destination before creating a recovery journal.
  while read -r old new path; do
    [[ -n "\${path:-}" ]] || continue
    validate_path "$path"; validate_parent_chain "$path"
    state="$(state_of "$old" "$new" "$path")"
    destinations=()
    case "$state" in
      replace|new) destinations=("$path") ;;
      merge-clean) destinations=("$path.embervy-merged") ;;
      diverged) destinations=("$path.embervy-new" "$path.embervy-base") ;;
    esac
    for target in "\${destinations[@]}"; do
      validate_parent_chain "$target"
      [[ ! -d "$HOME_DIR/$target" || -L "$HOME_DIR/$target" ]] || fail "destination is a directory: $target"
      [[ -z "\${targets[$target]+set}" ]] || fail "conflicting destination: $target"
      targets["$target"]=1
    done
    printf '%s %s %s\\n' "$state" "$new" "$path" >> "$PLAN"
  done < "$MANIFEST"
  mkdir -m 0700 -- "$BACKUP" || fail "cannot create backup"
  printf '%s\\n' "$HOME_DIR" > "$BACKUP/home.txt"
  : > "$BACKUP/touched.txt"; : > "$BACKUP/absent.txt"; : > "$BACKUP/created-dirs.txt"
  tar --create --file="$BACKUP/files.tar" --files-from=/dev/null
  # The complete touch set is backed up before the first house write.
  while read -r state new path; do
    case "$state" in
      replace|new) record_touch "$path" ;;
      merge-clean) record_touch "$path.embervy-merged" ;;
      diverged) record_touch "$path.embervy-new"; record_touch "$path.embervy-base" ;;
    esac
  done < "$PLAN"
  while read -r state new path; do
    case "$state" in
      replace)
        install_payload "$path"
        [[ "$(hash_file "$HOME_DIR/$path")" == "$new" ]] || fail "verification failed: $path"
        ((replace+=1)) ;;
      new)
        install_payload "$path"
        [[ "$(hash_file "$HOME_DIR/$path")" == "$new" ]] || fail "verification failed: $path"
        ((fresh+=1)) ;;
      merge-clean)
        install_payload "$path.embervy-merged" "$path" "$MERGES/$path"
        [[ "$(hash_file "$HOME_DIR/$path.embervy-merged")" == "$(hash_file "$MERGES/$path")" ]] || fail "verification failed: $path"
        printf 'left %s.embervy-merged; your file is untouched; take it with update.sh take %q\\n' "$path" "$path"
        ((merged+=1)) ;;
      already) ((already+=1)) ;;
      kept) ((kept+=1)) ;;
      diverged)
        side="$path.embervy-new"; validate_parent_chain "$side"
        # Keep payload names independent from sidecar destinations.
        install_payload "$side" "$path"
        [[ "$(hash_file "$HOME_DIR/$side")" == "$new" ]] || fail "verification failed: $side"
        side="$path.embervy-base"
        if [[ -f "$PAYLOAD/$side" && ! -L "$PAYLOAD/$side" ]]; then
          install_payload "$side" "$side"
          [[ "$(hash_file "$HOME_DIR/$side")" == "$(hash_file "$PAYLOAD/$side")" ]] || fail "verification failed: $side"
          printf 'diff -u %q %q shows exactly what the update changes; carry that into your version.\\n' "$side" "$path.embervy-new"
        else
          # An empty placeholder keeps rollback symmetric but is not a claimed base.
          : > "$WORK/missing-base"
          install_payload "$side" "$side" "$WORK/missing-base"
          printf 'base unavailable for %q; %q is an empty placeholder, not the original. Compare %q with your version and carry the update in by hand.\\n' "$path" "$side" "$path.embervy-new"
        fi
        ((diverged+=1)) ;;
      deleted-upstream)
        printf 'deleted upstream, left in place: %s\\n' "$path"
        ((deleted+=1)) ;;
      *) fail "unknown state: $state" ;;
    esac
    version_hint "$state" "$path"
  done < "$PLAN"
  printf 'only replace and new were applied; merged counts .embervy-merged sidecars, diverged counts .embervy-new sidecars. Your changed files are untouched.\\n'
  printf 'summary: replace=%d already=%d kept=%d new=%d merged=%d diverged=%d deleted-upstream=%d\\n' "$replace" "$already" "$kept" "$fresh" "$merged" "$diverged" "$deleted"
}
take_letter() {
  local path="\${2:-}" old new entry found=0
  validate_path "$path"; validate_parent_chain "$path"
  [[ -d "$BACKUP" && ! -L "$BACKUP" ]] || fail "apply the letter before taking a merge"
  [[ "$(cat -- "$BACKUP/home.txt")" == "$HOME_DIR" ]] || fail "backup belongs to a different house"
  while read -r old new entry; do
    [[ "$entry" != "$path" || "$new" == DELETED ]] || found=1
  done < "$MANIFEST"
  [[ "$found" == 1 ]] || fail "path is not in this letter: $path"
  [[ -f "$HOME_DIR/$path.embervy-merged" && ! -L "$HOME_DIR/$path.embervy-merged" ]] || fail "no merged file: $path"
  [[ ! -d "$HOME_DIR/$path" || -L "$HOME_DIR/$path" ]] || fail "destination is a directory: $path"
  WORK="$(mktemp -d)"
  trap '[[ -z "\${WRITE_TEMP:-}" ]] || rm -f -- "$WRITE_TEMP"; rm -rf -- "$WORK"' EXIT
  # Preserve the pre-take version once, including across repeated takes.
  if ! grep -Fxq -- "$path" "$BACKUP/touched.txt"; then record_touch "$path"; fi
  install_payload "$path" "$path" "$HOME_DIR/$path.embervy-merged"
  printf 'taken %s; back restores the version before take\\n' "$path"
}
back_letter() {
  [[ -d "$BACKUP" && ! -L "$BACKUP" ]] || fail "no backup to restore"
  [[ "$(cat -- "$BACKUP/home.txt")" == "$HOME_DIR" ]] || fail "backup belongs to a different house"
  local path destination="$SCRIPT_DIR/backup.after-back" n=1
  WORK="$(mktemp -d)"
  trap 'rm -rf -- "$WORK"' EXIT
  # Extract outside the house, with numeric owners and special permission bits intact.
  tar --extract --file="$BACKUP/files.tar" --numeric-owner --same-owner --same-permissions -C "$WORK"
  while read -r path; do
    [[ -n "$path" ]] || continue
    validate_path "$path"; validate_parent_chain "$path"
    rm -rf -- "$HOME_DIR/$path"
    if exists_any "$WORK/$path"; then
      mkdir -p -- "$(dirname -- "$HOME_DIR/$path")"
      cp -a -- "$WORK/$path" "$HOME_DIR/$path"
    fi
  done < "$BACKUP/touched.txt"
  if [[ -f "$BACKUP/created-dirs.txt" ]]; then
    tac "$BACKUP/created-dirs.txt" | while read -r path; do
      [[ -n "$path" ]] && rmdir -- "$HOME_DIR/$path" 2>/dev/null || true
    done
  fi
  while exists_any "$destination"; do destination="$SCRIPT_DIR/backup.after-back.$n"; ((n+=1)); done
  mv -- "$BACKUP" "$destination"
  printf 'restored; backup kept at %s\\n' "$destination"
}

[[ -f "$MANIFEST" ]] || fail "manifest.txt is missing"
case "\${1:-}" in
  check) check_letter ;;
  apply) [[ -f "$ARCHIVE" ]] || fail "files.tar.gz is missing"; apply_letter ;;
  take) take_letter "$@" ;;
  back) back_letter ;;
  *) fail "usage: update.sh check | apply | take <path> | back" ;;
esac
`;
}

const MUST_RESOLVE = [
  { path: "Claude/app/server.ts", reason: "It carries TERMINAL_TMUX_SOCKET handling; leaving it stale makes the app look for the terminal on the old socket." },
];

function renderLetter(from: string, to: string, entries: Entry[], house: House, homeDefault: string, withdrawnFiles: number): string {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const folder = dirname(entry.path) === "." ? "Repository root" : dirname(entry.path);
    const kind = entry.oldHash === "ABSENT" ? "added" : entry.newHash === "DELETED" ? "deleted upstream" : "changed";
    const values = groups.get(folder) ?? [];
    values.push(`- \`${entry.path}\` (${kind})`);
    groups.set(folder, values);
  }
  const files = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, values]) => `### ${folder}\n\n${values.join("\n")}`).join("\n\n");
  const withdrawn = withdrawnFiles ? `\n\n${withdrawnFiles} withdrawn ${withdrawnFiles === 1 ? "file is" : "files are"} not listed and may remain in the house.` : "";
  const critical = MUST_RESOLVE.filter(file => entries.some(entry => entry.path === file.path && entry.newHash !== "DELETED"));
  const resolution = critical.length ? `## Must resolve before reporting applied\n\n${critical.map(file => `- \`${file.path}\`: any \`.embervy-merged\` or \`diverged\` state must be resolved in the live file before reporting "applied". ${file.reason}`).join("\n")}\n\n` : "";
  const who = house === "claude"
    ? "The agent's own permission check can block `update.sh apply` as a deployment. The person runs `! bash update.sh apply` in the agent's terminal. The agent runs `bash update.sh check` before and after, then the doctor."
    : "On the person's word, the agent runs `bash update.sh check`, applies with `bash update.sh apply`, runs `check` again, then the doctor.";
  return `# Update letter\n\n## Who applies it\n\n${who}\n\nNever apply without the person's word.\n\nCommit range: \`${from}\` → \`${to}\`\n\n## What changes and why\n\n_Fill this section in before sending the letter._\n\n## Files in this letter\n\n${files || "No changed files."}${withdrawn}\n\n${resolution}## Applying the letter\n\nThis letter was built for \`${homeDefault}\` (the builder's \`--home-default\`). Every verb uses that house unless you explicitly pass \`--home <dir>\`, for example \`bash update.sh check --home /path/to/house\`. The option works with \`check\`, \`apply\`, \`take <path>\` and \`back\`, before or after the verb. \`EMBERVY_HOME\` never selects a house: if set and different from the built home (including an empty value), it stops the command before any letter or house is read, unless \`--home\` was given. An equal value is fine. The first output line is \`house: <absolute dir> (built for this house)\` or \`house: <absolute dir> (--home)\`; even a routing refusal names the intended house. Take and back also refuse a backup belonging to another house.\n\nRun \`./update.sh check\`, review the result, then run \`./update.sh apply\`. Use \`./update.sh back\` to restore the pre-update state.\n\nApply writes only unchanged files and new paths. Your changed files stay untouched, even when a clean merge is possible. For a clean merge, apply writes \`<path>.embervy-merged\` beside your file; review it and run \`./update.sh take <path>\` to adopt it yourself. Take is recorded in the same backup, so back restores the version from before take. The backup keeps saved files in \`backup/files.tar\`, so test runners cannot discover old tests by filename, and restores your exact pre-apply bytes, owners and modes. Keep independent writers stopped during apply, take and back.\n\nCheck is read-only. It reports \`replace\`, \`already\`, \`kept\`, \`new\`, \`merge-clean\`, \`diverged\`, or \`deleted-upstream\`, with summary counts. \`kept\` means your file differs from the update but already contains all its changes; apply leaves it untouched and writes no sidecars for it. \`merge-clean\` means a temporary three-way merge succeeded; apply leaves the result beside your unchanged file as \`<path>.embervy-merged\` for your decision.\n\nFor \`diverged\` paths, your file stays untouched. \`<path>.embervy-base\` holds the committed old version and \`<path>.embervy-new\` holds the update. Run \`diff -u <path>.embervy-base <path>.embervy-new\` to see exactly what the update changes; carry that into your version. Back removes new sidecars or restores any previous ones. When no base exists (including a new upstream path), the base sidecar is an explicitly reported empty placeholder, not an original version.\n\nWhen \`sw.js\` or \`index.html\` is \`merge-clean\` or \`diverged\`, check and apply remind you to keep your asset versions and service-worker cache number above the letter's, with a house suffix, so phones fetch the new files. For house changes, raise the asset \`?v=\` values in \`index.html\` and \`sw.js\` and the \`CACHE_NAME\` in \`sw.js\`, using a house suffix such as \`?v=115-h1\` and \`embervy-v30-h1\`; increase the suffix for later house changes. Letters only raise the plain number, without a house suffix.\n\nPreparing a merged sidecar needs optional GNU diffutils \`diff3 -m -E\`. Identical overlapping changes are not conflicts. Without diff3, with conflicting overlapping changes, a NUL byte in any version, or a missing base, apply uses conflict sidecars instead. Runtime requirements remain Bash 4 or newer and GNU coreutils, findutils and tar.\n\nWhen running a test file, put \`./\` before its path: \`bun test ./shared/tools/x.test.ts\`. Without \`./\`, Bun treats the argument as a name filter and may also discover other matching files.\n`;
}

export function buildLetter(options: Options, cwd = process.cwd()): Entry[] {
  const privateNames = readPrivateOldNames();
  // The package checker applies patterns per line, so anchored patterns must work here too.
  const isPrivate = (value: string) => value.split("\n").some((line) => privateNames.some((pattern) => pattern.test(line)));
  const repo = text(["git", "rev-parse", "--show-toplevel"], cwd);
  const from = text(["git", "rev-parse", "--verify", `${options.from}^{commit}`], repo);
  const to = text(["git", "rev-parse", "--verify", `${options.to}^{commit}`], repo);
  const fromTree = tree(from, repo);
  const toTree = tree(to, repo);
  let measured: Set<string> | undefined;
  if (options.onlyExisting) {
    const measurement = resolve(cwd, options.onlyExisting);
    measured = new Set(readFileSync(measurement, "utf8").split(/\r?\n/).map((p) => p.replace(/^\.\//, "")).filter(Boolean));
  }
  const candidates = [...new Set([...fromTree.keys(), ...toTree.keys()])].filter((path) => carriedByHouse(path, options.house)).sort();
  const entries: Entry[] = [];
  let withdrawnFiles = 0;
  for (const path of candidates) {
    if (!safePath(path)) throw new Error(`unsupported repository path: ${JSON.stringify(path)}`);
    const oldBytes = fromTree.has(path) ? blob(from, path, repo) : undefined;
    const newBytes = toTree.has(path) ? blob(to, path, repo) : undefined;
    const oldHash = oldBytes ? digest(oldBytes) : "ABSENT";
    const newHash = newBytes ? digest(newBytes) : "DELETED";
    if (oldHash === newHash) continue;
    if (measured && !measured.has(path) && oldHash !== "ABSENT") continue;
    if (newHash === "DELETED" && isPrivate(path)) {
      withdrawnFiles++;
      continue;
    }
    if (toTree.has(path) && !["100644", "100755"].includes(toTree.get(path)!)) {
      throw new Error(`unsupported target file type: ${path}; letters carry regular files only`);
    }
    entries.push({ path, oldHash, newHash });
  }

  for (const entry of entries) {
    for (const suffix of [".embervy-new", ".embervy-base", ".embervy-merged"]) {
      const sidecar = `${entry.path}${suffix}`;
      if (candidates.some((path) => path === sidecar || path.startsWith(`${sidecar}/`))) {
        throw new Error(`sidecar conflicts with repository path: ${sidecar}`);
      }
    }
  }
  const out = resolve(cwd, options.out);
  mkdirSync(out, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "embervy-update-letter-"));
  try {
    for (const entry of entries) {
      if (entry.newHash === "DELETED") continue;
      const target = join(stage, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob(to, entry.path, repo));
      if (entry.oldHash !== "ABSENT") {
        const base = blob(from, entry.path, repo);
        // Without a safe base, the house uses its existing manual-merge fallback.
        if (!isPrivate(Buffer.from(base).toString("utf8"))) writeFileSync(`${target}.embervy-base`, base);
      }
    }
    run(["tar", "-czf", join(out, "files.tar.gz"), "-C", stage, "."], repo);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  writeFileSync(join(out, "manifest.txt"), entries.map((e) => `${e.oldHash} ${e.newHash} ${e.path}`).join("\n") + (entries.length ? "\n" : ""));
  // A shipped file hash counts as unmodified, so updates replace it without a manual merge.
  const known: string[] = [];
  for (const e of entries) {
    if (e.newHash === "DELETED") continue;
    const commits = run(["git", "log", "--format=%H", to, "--", e.path], repo).toString().split("\n").filter(Boolean);
    const blobs = new Set<string>();
    for (const c of commits) {
      const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${c}:${e.path}`], { cwd: repo, stdout: "pipe", stderr: "ignore" });
      if (r.exitCode === 0) blobs.add(r.stdout.toString().trim());
    }
    for (const id of blobs) known.push(`${digest(run(["git", "cat-file", "blob", id], repo))} ${e.path}`);
  }
  writeFileSync(join(out, "known.txt"), [...new Set(known)].join("\n") + (known.length ? "\n" : ""));
  writeFileSync(join(out, "update.sh"), renderScript(resolve(cwd, options.homeDefault)));
  chmodSync(join(out, "update.sh"), 0o755);
  writeFileSync(join(out, "UPDATE.md"), renderLetter(from, to, entries, options.house, resolve(cwd, options.homeDefault), withdrawnFiles));
  return entries;
}

if (import.meta.main) {
  try {
    const entries = buildLetter(parseArgs(process.argv.slice(2)));
    console.log(`built update letter with ${entries.length} changed file(s)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
