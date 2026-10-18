"""Small formatting helpers shared by the planner and its explanation templates."""

from __future__ import annotations

_WORDS = ("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten")


def hhmm(minutes: int) -> str:
    m = minutes % (24 * 60)
    return f"{m // 60:02d}:{m % 60:02d}"


def to_minutes(value: str) -> int:
    h, m = value.split(":")[:2]
    return int(h) * 60 + int(m)


def lower_first(s: str) -> str:
    return s[:1].lower() + s[1:]


def count_word(n: int) -> str:
    return _WORDS[n] if 0 <= n < len(_WORDS) else str(n)


def rupees(n: int) -> str:
    """Indian digit grouping: ₹1,20,000."""
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return f"{'-' if n < 0 else ''}₹{s}"
