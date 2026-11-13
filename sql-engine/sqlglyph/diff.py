"""Small line-level diff used by the conversion analysis panel."""

from __future__ import annotations

import difflib
from typing import Any, Dict, List

MAX_ROWS = 5000


def line_diff(original: str, converted: str) -> Dict[str, Any]:
    old_lines = original.splitlines()
    new_lines = converted.splitlines()
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    rows: List[Dict[str, Any]] = []
    added = 0
    removed = 0
    unchanged = 0
    truncated = False

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                rows.append(
                    {
                        "type": "context",
                        "oldLine": i1 + offset + 1,
                        "newLine": j1 + offset + 1,
                        "text": old_lines[i1 + offset],
                    }
                )
                unchanged += 1
        elif tag == "replace":
            for index in range(i1, i2):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                rows.append(
                    {
                        "type": "removed",
                        "oldLine": index + 1,
                        "newLine": None,
                        "text": old_lines[index],
                    }
                )
                removed += 1
            for index in range(j1, j2):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                rows.append(
                    {
                        "type": "added",
                        "oldLine": None,
                        "newLine": index + 1,
                        "text": new_lines[index],
                    }
                )
                added += 1
        elif tag == "delete":
            for index in range(i1, i2):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                rows.append(
                    {
                        "type": "removed",
                        "oldLine": index + 1,
                        "newLine": None,
                        "text": old_lines[index],
                    }
                )
                removed += 1
        elif tag == "insert":
            for index in range(j1, j2):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                rows.append(
                    {
                        "type": "added",
                        "oldLine": None,
                        "newLine": index + 1,
                        "text": new_lines[index],
                    }
                )
                added += 1
        if truncated:
            break

    return {
        "rows": rows,
        "added": added,
        "removed": removed,
        "unchanged": unchanged,
        "changed": added > 0 or removed > 0,
        "truncated": truncated,
    }
