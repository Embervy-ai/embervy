#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════
# Embervy browser module — installs what browse.py needs: a private Python
# venv with Playwright and a headless Chromium (plus the system libraries
# it links against). Idempotent: re-running updates in place.
#
#   bash install.sh           install or update, then check once
#   bash install.sh --check   check only, change nothing
#
# Everything lands under $EMBERVY_BROWSER_HOME (default
# $EMBERVY_HOME/state/browser):
#   venv/           Python + Playwright
#   ms-playwright/  the headless Chromium
#   profile/        the login profile (created on first use, owner-only)
# Removing the module = deleting that folder; it takes the logins with it.
#
# The check launches Chromium headless, renders a blank local page and
# takes one screenshot — no network, no website, no profile touched.
# The last line of output is always browser_available=1 (…) or
# browser_available=0 (reason); exit code 0 only when the check passed.
# ═════════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMBERVY_HOME="${EMBERVY_HOME:-$(cd "$HERE/../../.." && pwd)}"
BROWSER_HOME="${EMBERVY_BROWSER_HOME:-$EMBERVY_HOME/state/browser}"
VENV="$BROWSER_HOME/venv"
PY="${EMBERVY_BROWSER_PYTHON:-$VENV/bin/python}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$BROWSER_HOME/ms-playwright}"
# Pin the package so every house gets the same driver and matching Chromium.
PLAYWRIGHT_SPEC="playwright==1.64.0"

say() { printf '== browser: %s ==\n' "$*"; }
unavailable() { echo "WARN: $1"; echo "browser_available=0 ($1)"; exit 1; }

check() {
  if [ ! -x "$PY" ]; then
    echo "browser_available=0 (no Python with Playwright at $PY — run: bash $HERE/install.sh)"
    return 1
  fi
  timeout 120 "$PY" - <<'PYEOF'
import os, shutil, sys, tempfile
try:
    import importlib.metadata as md
    from playwright.sync_api import sync_playwright
    version = md.version("playwright")
except Exception as exc:
    print(f"browser_available=0 (Playwright missing: {exc})")
    sys.exit(1)
tmp = tempfile.mkdtemp(prefix="embervy-browser-check-")
shot = os.path.join(tmp, "blank.png")
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("about:blank")
        page.set_content("<h1>ok</h1>")
        page.screenshot(path=shot)
        chromium = browser.version
        browser.close()
    size = os.path.getsize(shot)
    if size < 100:
        raise RuntimeError(f"the screenshot is only {size} bytes")
    print(f"browser_available=1 (Playwright {version}, Chromium {chromium}, headless screenshot {size} bytes)")
except Exception as exc:
    lines = str(exc).strip().splitlines()
    print(f"browser_available=0 (Chromium did not start: {(lines[0] if lines else type(exc).__name__)[:300]})")
    sys.exit(1)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
  local rc=$?
  [ "$rc" -eq 124 ] && echo "browser_available=0 (the check timed out after 120 s)"
  return "$rc"
}

if [ "${1:-}" = "--check" ]; then
  check
  exit $?
fi

IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
HAS_APT=0; command -v apt-get >/dev/null 2>&1 && HAS_APT=1
apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" \
    || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"; }
}

mkdir -p "$BROWSER_HOME" || unavailable "cannot create $BROWSER_HOME"
chmod 700 "$BROWSER_HOME"

# 1. A private venv — system Python is "externally managed" on current
#    Debian/Ubuntu, and Playwright must not collide with anything else.
#    Debian/Ubuntu ship venv support as its own package.
if [ ! -x "$VENV/bin/python" ]; then
  say "creating the Python environment"
  if ! python3 -m venv "$VENV" >/dev/null 2>&1; then
    rm -rf "$VENV"
    if [ "$IS_ROOT" = 1 ] && [ "$HAS_APT" = 1 ]; then
      apt_install python3-venv >/dev/null
    fi
    python3 -m venv "$VENV" || { rm -rf "$VENV"; unavailable "could not create a Python venv (install python3-venv)"; }
  fi
fi

# 2. Playwright (the Python package; it carries its own driver).
say "installing Playwright"
"$VENV/bin/python" -m pip install -q --disable-pip-version-check --no-cache-dir --upgrade "$PLAYWRIGHT_SPEC" \
  || unavailable "pip could not install $PLAYWRIGHT_SPEC"

# 3. Headless Chromium only (no full browser, no Firefox/WebKit). With root
#    and apt, also the system libraries Chromium needs.
say "installing headless Chromium"
if [ "$IS_ROOT" = 1 ] && [ "$HAS_APT" = 1 ]; then
  if ! "$VENV/bin/python" -m playwright install --with-deps --only-shell --no-progress chromium; then
    echo "WARN: system libraries for Chromium could not be installed — trying the browser alone"
    "$VENV/bin/python" -m playwright install --only-shell --no-progress chromium || unavailable "Chromium download failed"
  fi
else
  echo "WARN: not root or no apt — installing Chromium without its system libraries"
  "$VENV/bin/python" -m playwright install --only-shell --no-progress chromium || unavailable "Chromium download failed"
fi

# 4. Prove it once.
say "checking"
check
exit $?
