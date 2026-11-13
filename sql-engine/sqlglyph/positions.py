"""Mapping between SQLGlot character offsets and VS Code UTF-16 positions."""

from __future__ import annotations

import bisect
from typing import Dict, List, Optional


class PositionMapper:
    """Convert character offsets in a string to 1-based line/column positions.

    VS Code columns are UTF-16 code units, while Python string offsets are
    Unicode code points.  The two differ only when non-BMP characters appear
    before a node.  This mapper keeps the conversion cheap for normal SQL by
    pre-computing per-line UTF-16 starts and only encoding the relevant line.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.line_starts: List[int] = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self.line_starts.append(index + 1)

        self._line_utf16_starts: List[int] = []
        total = 0
        for start in self.line_starts:
            self._line_utf16_starts.append(total)
            end = text.find("\n", start)
            if end == -1:
                end = len(text)
            total += self._utf16_len(text[start:end]) + 1

        self._ascii = text.isascii()

    @staticmethod
    def _utf16_len(value: str) -> int:
        return len(value.encode("utf-16-le")) // 2

    def line_index(self, offset: int) -> int:
        if offset <= 0:
            return 0
        if offset >= len(self.text):
            return len(self.line_starts) - 1
        return bisect.bisect_right(self.line_starts, offset) - 1

    def to_utf16_offset(self, offset: int) -> int:
        if offset < 0:
            return 0
        if offset > len(self.text):
            offset = len(self.text)
        if self._ascii:
            return offset
        line = self.line_index(offset)
        line_start = self.line_starts[line]
        column = self._utf16_len(self.text[line_start:offset])
        return self._line_utf16_starts[line] + column

    def position(self, offset: int) -> Dict[str, int]:
        line = self.line_index(offset)
        line_start = self.line_starts[line]
        if self._ascii:
            column = max(0, offset - line_start)
        else:
            column = self._utf16_len(self.text[line_start:offset])
        return {"line": line + 1, "col": column + 1}

    def span(self, start: Optional[int], end: Optional[int]) -> Optional[Dict[str, int]]:
        if start is None or end is None:
            return None
        if start < 0:
            start = 0
        if end < start:
            end = start
        position = self.position(start)
        return {
            "start": self.to_utf16_offset(start),
            "end": self.to_utf16_offset(end),
            "line": position["line"],
            "col": position["col"],
        }

    def span_from_meta(self, meta: Dict[str, object]) -> Optional[Dict[str, int]]:
        if not meta:
            return None
        start = meta.get("start")
        end = meta.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            return None
        # SQLGlot's end offset is inclusive for tokens.
        return self.span(start, end + 1)

    def slice(self, start: Optional[int], end: Optional[int]) -> str:
        if start is None or end is None:
            return ""
        return self.text[max(0, start) : max(0, end)]
