"""Reading a receipt photo with Gemini: what comes back is checked field by field, and failures are plain."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import date

import httpx
import pytest

from app.adapters.receipts import ScanFailed, scan_receipt, scanning_available
from app.config import get_settings
from app.services.expense_text import ExpenseDraft

TODAY = date(2026, 11, 24)
PHOTO = b"\xff\xd8\xff\xe0\x00\x10JFIF a receipt"
GOOD = {"merchant": "Truffles", "date": "2026-11-20", "total": 1240.5, "gst": 59.07, "gstin": "29abcde1234f1z5", "category": "food"}


@pytest.fixture(autouse=True)
def helper_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")


def _gemini(seen: list[httpx.Request], reply: object = None, status: int = 200, raw: str | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"code": status, "status": "RESOURCE_EXHAUSTED"}})
        text = raw if raw is not None else json.dumps(reply)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}}]})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _scan(client: httpx.AsyncClient, content_type: str = "image/jpeg", image: bytes = PHOTO) -> ExpenseDraft | None:
    return asyncio.run(scan_receipt(image, content_type, TODAY, client=client))


def test_a_good_answer_becomes_a_draft():
    seen: list[httpx.Request] = []

    d = _scan(_gemini(seen, GOOD))

    assert d == ExpenseDraft(
        title="Truffles",
        amount_paise=124050,
        tax_paise=5907,
        category="food",
        payment=None,
        day=date(2026, 11, 20),
        gstin="29ABCDE1234F1Z5",
        merchant="Truffles",
        source="receipt",
    )
    (req,) = seen
    assert req.headers["x-goog-api-key"] == "test-key"
    assert "test-key" not in str(req.url) and "key=" not in str(req.url)
    assert req.url.path.endswith(f"/models/{get_settings().gemini_model}:generateContent")
    body = json.loads(req.content)
    (photo,) = [p["inline_data"] for p in body["contents"][0]["parts"] if "inline_data" in p]
    assert photo["mime_type"] == "image/jpeg"
    assert base64.b64decode(photo["data"]) == PHOTO
    assert "2026-11-24" in json.dumps(body["contents"])
    assert body["systemInstruction"]["parts"][0]["text"]
    config = body["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert set(config["responseSchema"]["properties"]) == {"merchant", "date", "total", "gst", "gstin", "category"}


@pytest.mark.parametrize("content_type", ["image/png", "image/webp", "IMAGE/PNG; charset=binary", "image/jpg"])
def test_png_and_webp_are_read_too(content_type):
    seen: list[httpx.Request] = []
    assert _scan(_gemini(seen, GOOD), content_type) is not None
    (photo,) = [p["inline_data"] for p in json.loads(seen[0].content)["contents"][0]["parts"] if "inline_data" in p]
    assert photo["mime_type"] == content_type.split(";")[0].lower().replace("jpg", "jpeg")


def test_fields_that_dont_hold_up_are_dropped():
    reply = {"merchant": "   ", "date": "2026-12-01", "total": "1,500", "gst": 1500, "gstin": "29ABCDE1234F1X5", "category": "groceries"}

    d = _scan(_gemini([], reply))

    assert d == ExpenseDraft(
        title="Expense",
        amount_paise=150000,
        tax_paise=None,
        category=None,
        payment=None,
        day=None,
        gstin=None,
        merchant=None,
        source="receipt",
    )


@pytest.mark.parametrize(
    ("said", "day"),
    [
        ("2026-11-24", date(2026, 11, 24)),
        ("2025-11-25", date(2025, 11, 25)),
        ("2026-11-25", None),
        ("2025-11-23", None),
        ("20/11/2026", None),
        ("2026-02-30", None),
        (20261120, None),
        (None, None),
    ],
)
def test_a_receipt_date_is_within_the_past_year(said, day):
    assert _scan(_gemini([], {**GOOD, "date": said})).day == day


def test_without_a_merchant_the_category_names_it():
    d = _scan(_gemini([], {"merchant": None, "date": None, "total": 80, "gst": None, "gstin": None, "category": "Transport"}))
    assert (d.title, d.category, d.amount_paise, d.merchant) == ("Transport", "transport", 8000, None)


@pytest.mark.parametrize("total", [None, 0, -50, 1_000_000, 2_500_000.5, "abc", True, [1240], "NaN", "Infinity"])
def test_no_usable_total_fails(total):
    with pytest.raises(ScanFailed, match="^Couldn't read a total on that receipt.$"):
        _scan(_gemini([], {**GOOD, "total": total}))


def test_a_total_just_under_ten_lakh_is_kept():
    assert _scan(_gemini([], {**GOOD, "total": 999_999.99, "gst": None})).amount_paise == 99_999_999


def test_a_used_up_quota_fails_plainly():
    seen: list[httpx.Request] = []
    with pytest.raises(ScanFailed, match="busy"):
        _scan(_gemini(seen, status=429))
    assert len(seen) == 1


@pytest.mark.parametrize("status", [400, 403, 500, 503])
def test_an_error_from_gemini_fails_without_logging_the_photo_or_key(status, caplog):
    caplog.set_level(logging.DEBUG)
    with pytest.raises(ScanFailed):
        _scan(_gemini([], status=status))
    assert "test-key" not in caplog.text
    assert base64.b64encode(PHOTO).decode() not in caplog.text


@pytest.mark.parametrize("error", [httpx.ReadTimeout, httpx.ConnectTimeout, httpx.ConnectError])
def test_a_timeout_or_no_connection_fails(error):
    def handler(request: httpx.Request) -> httpx.Response:
        raise error("no answer", request=request)

    with pytest.raises(ScanFailed):
        _scan(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", '"text"', ""])
def test_an_answer_that_isnt_an_object_fails(raw):
    with pytest.raises(ScanFailed):
        _scan(_gemini([], raw=raw))


@pytest.mark.parametrize("content_type", ["application/pdf", "image/gif", "image/heic", "text/plain", ""])
def test_only_photos_are_sent(content_type):
    seen: list[httpx.Request] = []
    with pytest.raises(ScanFailed, match="^Send a photo: JPEG, PNG or WebP.$"):
        _scan(_gemini(seen, GOOD), content_type)
    assert seen == []


def test_an_empty_or_huge_photo_isnt_sent():
    seen: list[httpx.Request] = []
    with pytest.raises(ScanFailed):
        _scan(_gemini(seen, GOOD), image=b"")
    with pytest.raises(ScanFailed, match="too large"):
        _scan(_gemini(seen, GOOD), image=b"\xff" * (12 * 1024 * 1024 + 1))
    assert seen == []


def test_with_the_helper_off_nothing_is_read(monkeypatch):
    seen: list[httpx.Request] = []
    assert scanning_available()

    monkeypatch.setattr(get_settings(), "ai_helper_enabled", False)
    assert not scanning_available()
    assert _scan(_gemini(seen, GOOD)) is None

    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    assert not scanning_available()
    assert _scan(_gemini(seen, GOOD)) is None
    assert seen == []
