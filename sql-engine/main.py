#!/usr/bin/env python3
"""Entry point for the SQL Glyph local engine.

The extension starts this file as a subprocess and communicates over JSON
Lines on stdin/stdout.  This script never connects to a database and never
executes user SQL; it only parses and generates SQL with SQLGlot.
"""

from __future__ import annotations

import os
import sys

# Make the bundled package importable regardless of the process working
# directory.  The extension resolves this script path from the installation
# location, never from the current working directory.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from sqlglyph.protocol import main  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
