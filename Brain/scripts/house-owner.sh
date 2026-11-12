# house-owner.sh — the house seam for "is this process mine?" (sourced, not run).
#
# Several houses can share one server; embervy_owns_pid decides by the
# process's systemd unit and folder (shared/scripts/house-runtime.sh, next to
# Brain/). Without that file Brain runs alone and every process is its own.

HOUSE_RUNTIME="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/house-runtime.sh"
if [ -f "$HOUSE_RUNTIME" ]; then
  . "$HOUSE_RUNTIME"
  EMBERVY_HOME="${EMBERVY_HOME:-$BRAIN_HOME}"
else
  embervy_owns_pid() { return 0; }
fi
