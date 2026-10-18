from __future__ import annotations

from datetime import UTC, datetime, time

from app.pagination import decode_cursor, encode_cursor
from app.services.timefmt import hhmm, local_minutes, minutes_of_day, parse_hhmm, parse_offset, to_local_iso


def test_iso_times_use_the_city_offset():
    assert to_local_iso(datetime(2026, 10, 14, 5, 25, tzinfo=UTC), "+05:30") == "2026-10-14T10:55:00+05:30"
    assert to_local_iso(None, "+05:30") is None
    assert to_local_iso(datetime(2026, 10, 14, 5, 25), "+05:30") == "2026-10-14T10:55:00+05:30"


def test_times_of_day():
    assert parse_hhmm("21:30") == time(21, 30)
    assert hhmm(time(7, 5)) == "07:05"
    assert minutes_of_day(time(10, 55)) == 655
    assert local_minutes(datetime(2026, 10, 14, 5, 25, tzinfo=UTC), "+05:30") == 655
    assert parse_offset("-03:30").utcoffset(None).total_seconds() == -12600


def test_cursors_round_trip():
    assert decode_cursor(encode_cursor({"c": "2026-10-14T10:55:00+05:30", "i": "con-1"})) == {"c": "2026-10-14T10:55:00+05:30", "i": "con-1"}
