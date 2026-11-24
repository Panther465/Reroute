"""A typed expense line becomes a draft: amount in paise, GST, GSTIN, payment, day, category, merchant and title."""

from __future__ import annotations

from datetime import date

import pytest

from app.services.expense_text import CATEGORIES, PAYMENTS, ExpenseDraft, merchant_key, parse_expense

TODAY = date(2026, 11, 24)


def draft(title: str, amount: int | None, category: str | None = None, payment: str | None = None, **rest) -> ExpenseDraft:
    fields = {"tax_paise": None, "day": None, "gstin": None, "merchant": None} | rest
    return ExpenseDraft(title=title, amount_paise=amount, category=category, payment=payment, **fields)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Lunch 350 cash at Truffles", draft("Lunch at Truffles", 35000, "food", "cash", merchant="Truffles")),
        ("₹1,240 hotel dinner card", draft("Hotel dinner", 124000, "food", "card")),
        ("auto 80", draft("Auto", 8000, "transport")),
        ("Uber to airport Rs. 612.50 upi", draft("Uber to airport", 61250, "transport", "upi", merchant="Uber")),
        ("chai 20", draft("Chai", 2000, "food")),
        ("Printing 45 yesterday", draft("Printing", 4500, "office", day=date(2026, 11, 23))),
        ("Client dinner at Toit 3.2k card", draft("Client dinner at Toit", 320000, "client", "card", merchant="Toit")),
        (
            "Hotel 4500 incl GST 540 GSTIN 29ABCDE1234F1Z5",
            draft("Hotel", 450000, "stay", tax_paise=54000, gstin="29ABCDE1234F1Z5"),
        ),
        ("metro 40 on 15 Oct", draft("Metro", 4000, "transport", day=date(2026, 10, 15))),
        ("SIM recharge 299 gpay", draft("SIM recharge", 29900, "communication", "upi")),
    ],
)
def test_the_examples(text, expected):
    assert parse_expense(text, TODAY) == expected


@pytest.mark.parametrize(
    ("text", "paise"),
    [
        ("Lunch 350", 35000),
        ("Lunch ₹350", 35000),
        ("Lunch ₹ 350", 35000),
        ("Lunch Rs 350", 35000),
        ("Lunch Rs. 350/-", 35000),
        ("Lunch Rs.350", 35000),
        ("Lunch INR 350", 35000),
        ("Lunch 350 rupees", 35000),
        ("Lunch 350rs", 35000),
        ("Lunch 350 only", 35000),
        ("Lunch 1,240", 124000),
        ("Lunch 612.50", 61250),
        ("Lunch 612.5", 61250),
        ("Dinner 3.2k", 320000),
        ("Dinner 3K", 300000),
        ("Hotel 1.5 lakh", 15000000),
        ("Hotel 2 lacs", 20000000),
        ("Hotel 1.5L", 15000000),
        ("Hotel 1,50,000", 15000000),
        ("Hotel 150,000", 15000000),
        ("Paid 350 for lunch", 35000),
    ],
)
def test_amounts_as_people_type_them(text, paise):
    d = parse_expense(text, TODAY)
    assert (d.amount_paise, d.title) == (paise, "Lunch" if "lunch" in text.lower() else text.split()[0])


@pytest.mark.parametrize(
    ("text", "paise", "title"),
    [
        ("2 coffees 240", 24000, "2 coffees"),
        ("3 chai 45", 4500, "3 chai"),
        ("Hotel 4500 for 2 nights", 450000, "Hotel for 2 nights"),
        ("Lunch for 2 350", 35000, "Lunch for 2"),
        ("Bus 45 for 2", 4500, "Bus for 2"),
        ("Printing 100 pages 50", 5000, "Printing 100 pages"),
        ("Cab 12 km 340", 34000, "Cab 12 km"),
        ("Train 12627 450", 45000, "Train 12627"),
        ("Room 304 1200", 120000, "Room 304"),
        ("Coffee 120 GSTIN 29ABCDE1234F1Z5", 12000, "Coffee"),
        ("Lunch 350 at 1pm", 35000, "Lunch"),
        ("Lunch 350 at 13:30", 35000, "Lunch"),
        ("Thali 180 + lassi 60 = 240", 24000, "Thali 180 + lassi 60"),
        ("Total 4720 room 4000", 472000, "Room 4000"),
        ("350 lunch", 35000, "Lunch"),
        ("Dinner 2 at Truffles 1500", 150000, "Dinner 2 at Truffles"),
        ("Hotel 15 Oct 2000", 200000, "Hotel"),
    ],
)
def test_the_total_is_chosen_among_several_numbers(text, paise, title):
    d = parse_expense(text, TODAY)
    assert (d.amount_paise, d.title) == (paise, title)


@pytest.mark.parametrize("text", ["GSTIN 29ABCDE1234F1Z5", "metro on 15/10", "chai on 15-10-2026", "auto on 15 Oct", "cab 31/02", "lunch at 1pm"])
def test_a_gstin_a_date_or_a_time_is_never_the_amount(text):
    assert parse_expense(text, TODAY).amount_paise is None


@pytest.mark.parametrize(
    ("text", "amount", "tax"),
    [
        ("Hotel 4500 incl GST 540", 450000, 54000),
        ("Dinner 1180 incl. GST 54", 118000, 5400),
        ("Hotel 4500 GST: 540", 450000, 54000),
        ("Hotel 4500 incl 540 GST", 450000, 54000),
        ("Hotel 5000 CGST 225 SGST 225", 500000, 45000),
        ("Hotel 5000 CGST 225 + SGST 225", 500000, 45000),
        ("Hotel 4550 + CGST 225 + SGST 225", 500000, 45000),
        ("Room 4000 + GST 720", 472000, 72000),
        ("Hotel 4000 + 720 GST", 472000, 72000),
        ("Hotel 4500 excl GST 810", 531000, 81000),
        ("Hotel 4500 GST 18%", 450000, None),
        ("Hotel 4500 incl GST", 450000, None),
        ("Hotel 500 GST 900", 50000, None),
    ],
)
def test_gst_in_the_amount(text, amount, tax):
    d = parse_expense(text, TODAY)
    assert (d.amount_paise, d.tax_paise, d.title) == (amount, tax, text.split()[0])


def test_a_toll_tax_is_the_expense_not_gst():
    assert parse_expense("Toll tax 100", TODAY) == draft("Toll tax", 10000, "transport")


@pytest.mark.parametrize(
    ("text", "gstin"),
    [
        ("Lunch 350 GSTIN 29ABCDE1234F1Z5", "29ABCDE1234F1Z5"),
        ("Lunch 350 gst no 29abcde1234f1z5", "29ABCDE1234F1Z5"),
        ("Lunch 350 GSTIN: 07AAACB2230M1ZT", "07AAACB2230M1ZT"),
        ("Lunch 350 GSTIN 29ABCDE1234F1X5", None),
    ],
)
def test_gstin(text, gstin):
    d = parse_expense(text, TODAY)
    assert (d.gstin, d.amount_paise) == (gstin, 35000)


@pytest.mark.parametrize(
    ("said", "payment"),
    [
        ("cash", "cash"),
        ("in cash", "cash"),
        ("card", "card"),
        ("credit card", "card"),
        ("debit card", "card"),
        ("by card", "card"),
        ("visa", "card"),
        ("mastercard", "card"),
        ("amex", "card"),
        ("rupay", "card"),
        ("upi", "upi"),
        ("gpay", "upi"),
        ("google pay", "upi"),
        ("phonepe", "upi"),
        ("paytm", "upi"),
        ("bhim", "upi"),
        ("wallet", "wallet"),
        ("reroute wallet", "wallet"),
        ("paytm wallet", "wallet"),
        ("company", "company"),
        ("corporate card", "company"),
        ("office paid", "company"),
        ("billed to company", "company"),
        ("paid by company", "company"),
    ],
)
def test_payment_words(said, payment):
    assert parse_expense(f"Lunch 300 {said}", TODAY) == draft("Lunch", 30000, "food", payment)


def test_a_card_or_a_company_that_isnt_the_payment():
    assert parse_expense("Metro card recharge 200", TODAY) == draft("Metro card recharge", 20000, "transport")
    assert parse_expense("SIM card 100 cash", TODAY) == draft("SIM card", 10000, "communication", "cash")
    assert parse_expense("Uber to company office 300", TODAY) == draft("Uber to company office", 30000, "transport", merchant="Uber")


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("cab 300", "transport"),
        ("taxi 300", "transport"),
        ("ola 300", "transport"),
        ("rapido 90", "transport"),
        ("rickshaw 60", "transport"),
        ("auto-rickshaw 60", "transport"),
        ("bus 30", "transport"),
        ("train ticket 450", "transport"),
        ("flight 5400", "transport"),
        ("petrol 1000", "transport"),
        ("diesel 1000", "transport"),
        ("fuel 1000", "transport"),
        ("toll 65", "transport"),
        ("parking 40", "transport"),
        ("hotel 3000", "stay"),
        ("room 3000", "stay"),
        ("lodge 900", "stay"),
        ("oyo 1200", "stay"),
        ("airbnb 4000", "stay"),
        ("guest house 900", "stay"),
        ("breakfast 120", "food"),
        ("tea 15", "food"),
        ("coffee 120", "food"),
        ("snacks 80", "food"),
        ("meal 200", "food"),
        ("thali 150", "food"),
        ("dhaba 250", "food"),
        ("restaurant 900", "food"),
        ("cafe 300", "food"),
        ("swiggy 450", "food"),
        ("zomato 450", "food"),
        ("nashta 60", "food"),
        ("khana 120", "food"),
        ("water 20", "food"),
        ("hotel breakfast 300", "food"),
        ("ticket 200", "tickets"),
        ("museum entry 50", "tickets"),
        ("show 500", "tickets"),
        ("data pack 300", "communication"),
        ("internet 500", "communication"),
        ("wifi 100", "communication"),
        ("hotel wifi 300", "communication"),
        ("phone 200", "communication"),
        ("print 20", "office"),
        ("stationery 150", "office"),
        ("courier 120", "office"),
        ("xerox 10", "office"),
        ("photocopy 10", "office"),
        ("client lunch 2000", "client"),
        ("entertainment 3000", "client"),
        ("gift for client 1500", "client"),
        ("team dinner 4000", "client"),
        ("team lunch at Truffles 3000", "client"),
        ("cab to client office 400", "transport"),
        ("haircut 200", None),
    ],
)
def test_categories(text, category):
    assert parse_expense(text, TODAY).category == category


def test_every_category_and_payment_is_one_of_ours():
    for text in ("cab 300 cash", "hotel 3000 card", "lunch 200 upi", "museum 50 wallet", "sim 299 company", "xerox 10", "gift 500"):
        d = parse_expense(text, TODAY)
        assert d.category in CATEGORIES and d.payment in (*PAYMENTS, None)


MEMORY = {
    "truffles": ("food", "card"),
    "toit": ("client", "company"),
    "thirdwavecoffee": ("food", None),
    "uber": ("transport", "upi"),
    "odd": ("not a category", "bitcoin"),
}


def test_a_known_merchant_brings_back_its_category_and_payment():
    assert parse_expense("Truffles 600", TODAY, MEMORY) == draft("Truffles", 60000, "food", "card", merchant="Truffles")
    assert parse_expense("toit 2400", TODAY, MEMORY) == draft("Toit", 240000, "client", "company", merchant="Toit")
    assert parse_expense("third wave coffee 280", TODAY, MEMORY) == draft("Third Wave Coffee", 28000, "food", merchant="Third Wave Coffee")
    assert parse_expense("Uber 300", TODAY, MEMORY) == draft("Uber", 30000, "transport", "upi", merchant="Uber")
    assert parse_expense("Dinner at Truffles Koramangala 900", TODAY, MEMORY).payment == "card"


def test_words_in_the_line_win_over_memory():
    assert parse_expense("Lunch at Truffles 600 cash", TODAY, MEMORY) == draft("Lunch at Truffles", 60000, "food", "cash", merchant="Truffles")
    # Beer isn't a category word: Toit's remembered category stays, but the payment said wins.
    assert parse_expense("Beer at Toit 2400 upi", TODAY, MEMORY) == draft("Beer at Toit", 240000, "client", "upi", merchant="Toit")
    assert parse_expense("Taxi to Toit 300", TODAY, MEMORY).category == "transport"


def test_memory_that_makes_no_sense_is_ignored():
    assert parse_expense("odd 100", TODAY, MEMORY) == draft("Odd", 10000, merchant="Odd")
    assert parse_expense("Truffles 600", TODAY, {"truffles": "food"}) == draft("Truffles", 60000, merchant="Truffles")  # type: ignore[dict-item]
    assert parse_expense("Truffles 600", TODAY, {}) == draft("Truffles", 60000)


@pytest.mark.parametrize(
    ("said", "day"),
    [
        ("today", date(2026, 11, 24)),
        ("yesterday", date(2026, 11, 23)),
        ("day before yesterday", date(2026, 11, 22)),
        ("on 15 Oct", date(2026, 10, 15)),
        ("15th October", date(2026, 10, 15)),
        ("Oct 15", date(2026, 10, 15)),
        ("15/10", date(2026, 10, 15)),
        ("15-10", date(2026, 10, 15)),
        ("15-10-2026", date(2026, 10, 15)),
        ("15/10/26", date(2026, 10, 15)),
        ("2026-10-15", date(2026, 10, 15)),
        ("15 Oct 2025", date(2025, 10, 15)),
        ("24 Nov", date(2026, 11, 24)),
        ("25 Nov", date(2025, 11, 25)),
        ("31 Feb", None),
        ("29 Feb", None),
    ],
)
def test_dates(said, day):
    d = parse_expense(f"cab {said} 300", TODAY)
    assert (d.day, d.amount_paise, d.title) == (day, 30000, "Cab")


@pytest.mark.parametrize(
    ("said", "day"),
    [
        ("15 Dec", date(2025, 12, 15)),
        ("15/12", date(2025, 12, 15)),
        ("Dec 31", date(2025, 12, 31)),
        ("5 Jan", date(2026, 1, 5)),
        ("6 Jan", date(2025, 1, 6)),
        ("yesterday", date(2026, 1, 4)),
    ],
)
def test_a_day_without_a_year_is_never_in_the_future(said, day):
    assert parse_expense(f"cab {said} 300", date(2026, 1, 5)).day == day


def test_29_february_finds_the_last_leap_year():
    assert parse_expense("cab 29 Feb 300", date(2029, 3, 1)).day == date(2028, 2, 29)


EMPTY = draft("Expense", None)


@pytest.mark.parametrize("text", ["", "   ", "!!! ???", "₹", "Rs.", "0", "--- /// ...", "\x00\x07", "@", "%%%"])
def test_garbage_gives_an_empty_draft(text):
    assert parse_expense(text, TODAY) == EMPTY


@pytest.mark.parametrize("text", ["Rs" * 300, "1" * 600, "9" * 40 + " lunch", "🍕🍕 500", "१२० चाय", "at at at", "₹₹₹ 3.2.1k", "15/10/15/10"])
def test_odd_input_never_raises(text):
    d = parse_expense(text, TODAY)
    assert isinstance(d, ExpenseDraft) and d.title
    assert d.amount_paise is None or 0 < d.amount_paise < 10_000_000 * 100


def test_odd_arguments_never_raise():
    assert parse_expense(None, TODAY) == EMPTY  # type: ignore[arg-type]
    assert parse_expense("cab 300", TODAY, {"cab": None}).amount_paise == 30000  # type: ignore[dict-item]


def test_a_title_is_never_empty():
    assert parse_expense("350 card", TODAY) == draft("Expense", 35000, payment="card")
    assert parse_expense("350 card", TODAY, {}).title == "Expense"
    assert parse_expense("at the hotel 3000", TODAY).title == "Hotel"


def test_merchant_key():
    assert merchant_key("Domino's Pizza") == merchant_key("dominos pizza") == "dominospizza"
    assert merchant_key("  Third Wave Coffee! ") == "thirdwavecoffee"
    assert merchant_key("Café 24/7") == "café247"
    assert merchant_key("") == ""


def test_how_people_tell_rico_reads_as_a_title():
    assert parse_expense("I paid 80 for an auto, cash", TODAY).title == "Auto"
    assert parse_expense("I spent 950 on lunch at Truffles by card", TODAY).title == "Lunch at Truffles"
    assert parse_expense("we bought snacks for 120", TODAY).title == "Snacks"
