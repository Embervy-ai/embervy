"""Read the shared Brain message catalogue; interpolate once, never translate data."""
import json
import os
import re
import subprocess
from pathlib import Path

_catalog = None


def set_catalog(catalog):
    global _catalog
    if isinstance(catalog, dict):
        _catalog = catalog


def tr(message, *values):
    global _catalog
    if _catalog is None:
        _catalog = json.loads(subprocess.check_output(
            [os.environ.get("BUN_BIN") or "bun", str(Path(__file__).resolve().parent.parent / "texts.ts"), "--catalog"],
            text=True, timeout=10))
    template = _catalog.get(message, message)
    return re.sub(r"\{(\d+)\}", lambda m: str(values[int(m[1])]) if int(m[1]) < len(values) else m[0], template)
