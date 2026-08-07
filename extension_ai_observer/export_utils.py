"""Grade export utilities – CSV and XLSX."""
from __future__ import annotations

import csv
import io


def grades_to_csv(grades: list[dict]) -> bytes:
    """Return a CSV file as bytes from a list of grade dicts."""
    if not grades:
        return b"No data\n"
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(grades[0].keys()))
    writer.writeheader()
    writer.writerows(grades)
    return buf.getvalue().encode("utf-8-sig")
