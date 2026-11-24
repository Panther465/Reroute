"""Understanding an expense typed in one line: "Lunch 350 cash at Truffles", "Uber to airport Rs. 612.50 upi".

Patterns only, no model. The line gives the amount (in paise) and any GST in it, the seller's GSTIN, how it was paid,
the day, what kind of expense it was and where. Whatever the line doesn't say stays empty for the traveller to fill,
except that a merchant they've used before brings back the category and payment they chose then.

Nothing here raises: a line it can't read gives a draft titled "Expense" with no amount.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

log = logging.getLogger("reroute.expenses")

CATEGORIES = ("transport", "stay", "food", "tickets", "communication", "office", "client", "other")
PAYMENTS = ("cash", "card", "upi", "wallet", "company")

#: A GSTIN: the state code, the seller's PAN (5 letters, 4 digits, a letter), an entity number, "Z", a check character.
GSTIN = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", re.I)


@dataclass(frozen=True)
class ExpenseDraft:
    """What a typed line or a receipt says about an expense: it fills the form, and the traveller checks it."""

    #: What it was, cleaned and capitalised: "Lunch at Truffles", "Auto", "Hotel dinner".
    title: str
    #: The total in paise (₹612.50 is 61250); None when no amount was found.
    amount_paise: int | None
    #: GST included in the amount, when stated ("GST 540", "incl. GST 54").
    tax_paise: int | None
    #: One of CATEGORIES, or None when nothing suggests one.
    category: str | None
    #: One of PAYMENTS, or None when not said.
    payment: str | None
    #: The day it was spent, when said: "yesterday", "15 Oct", "15/10".
    day: date | None
    #: The seller's GSTIN, upper-cased.
    gstin: str | None
    #: The shop or company: "at Truffles" is Truffles; "Uber" is Uber.
    merchant: str | None
    source: Literal["text", "receipt"] = "text"


def merchant_key(name: str) -> str:
    """The key a merchant is remembered by: "Domino's Pizza" and "dominos pizza" are both "dominospizza"."""
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def category_title(category: str | None) -> str:
    """A title for an expense that says nothing else: its category's name ("Food"), else "Expense"."""
    return _CATEGORY_TITLES.get(category or "", "Expense")


def parse_expense(text: str, today: date, memory: Mapping[str, tuple[str, str | None]] | None = None) -> ExpenseDraft:
    """A draft expense from one typed line. `memory` maps merchant_key(merchant) to the (category, payment) the
    traveller chose for that merchant before; words in the line always win over it. Never raises."""
    try:
        return _parse(text, today, memory)
    except Exception as exc:  # a draft to finish by hand beats an error over a line of text
        log.warning("Couldn't read a typed expense (%s)", type(exc).__name__)
        return _EMPTY


# ---------- the words it knows ----------

_CATEGORY_TITLES = {
    "transport": "Transport",
    "stay": "Stay",
    "food": "Food",
    "tickets": "Tickets",
    "communication": "Communication",
    "office": "Office",
    "client": "Client",
}
_EMPTY = ExpenseDraft(title="Expense", amount_paise=None, tax_paise=None, category=None, payment=None, day=None, gstin=None, merchant=None)

#: Longer text is cut: an expense is a line, and the patterns stay quick on anything pasted in.
LONGEST_TEXT = 500
#: A bare number this big (₹1 crore) is a phone number or an ID, not a price.
TOO_MUCH_RUPEES = Decimal(10_000_000)
#: A number up to this followed by a word counts things ("2 coffees", "3 chai") rather than rupees.
COUNTS_UP_TO = 20

_CATEGORY_WORDS = {
    "transport": "cab taxi uber ola rapido auto autorickshaw rickshaw metro bus train flight airport fuel petrol diesel toll parking "
    "railway irctc redbus fastag cng indigo spicejet",
    "stay": "oyo airbnb guesthouse hostel homestay",
    "food": "lunch dinner breakfast brunch chai tea coffee snacks snack meal thali dhaba restaurant cafe café swiggy zomato nashta "
    "khana water food juice tiffin canteen biryani dosa idli samosa starbucks chaayos dominos mcdonalds kfc",
    "tickets": "entry museum show movie cinema concert bookmyshow",
    "communication": "sim recharge data internet wifi phone mobile broadband jio airtel",
    "office": "print printing printout stationery stationary courier xerox photocopy scan scanning",
}
_KEYWORDS = {w: cat for cat, words in _CATEGORY_WORDS.items() for w in words.split()}
_KEYWORDS.update({"guest house": "stay", "wi fi": "communication", "air india": "transport", "akasa air": "transport"})
#: Words that suggest a category only when nothing else does: a "hotel dinner" is food, a "train ticket" transport.
_WEAK = {"hotel": "stay", "room": "stay", "stay": "stay", "lodge": "stay", "ticket": "tickets"}
#: A client's or the team's meal is client entertainment, not food.
_CLIENT_WORDS = {"client", "clients", "entertainment", "gift", "gifts"}
_MEALS = {"lunch", "lunches", "dinner", "dinners", "breakfast", "meal", "meals", "snacks", "outing", "party"}

#: Known companies, by merchant_key, as they write their names.
_BRANDS = {
    "uber": "Uber",
    "ola": "Ola",
    "rapido": "Rapido",
    "swiggy": "Swiggy",
    "zomato": "Zomato",
    "oyo": "OYO",
    "airbnb": "Airbnb",
    "irctc": "IRCTC",
    "redbus": "redBus",
    "indigo": "IndiGo",
    "airindia": "Air India",
    "spicejet": "SpiceJet",
    "akasaair": "Akasa Air",
    "starbucks": "Starbucks",
    "chaayos": "Chaayos",
    "dominos": "Domino's",
    "mcdonalds": "McDonald's",
    "kfc": "KFC",
    "bookmyshow": "BookMyShow",
    "jio": "Jio",
    "airtel": "Airtel",
}
#: After "at", words like these are a place, not a merchant: "lunch at the office".
_GENERIC_PLACES = {
    "the", "a", "my", "our", "office", "home", "hotel", "airport", "station", "railway", "bus", "stand", "stop", "work", "site",
    "client", "clients", "canteen", "shop", "stall", "restaurant", "cafe", "dhaba", "mall", "market", "metro", "room", "local",
}  # fmt: skip
#: Words that end a merchant's name after "at": "at Toit with the team".
_STOPS = {"at", "@", "on", "to", "for", "from", "in", "near", "via", "by", "and", "&", "+", "with", "after", "before", "using", "through", "paid"}
#: Dropped from either end of a title: "Lunch at" is "Lunch", "for lunch" is "Lunch".
_LEADING = {"at", "@", "on", "to", "for", "of", "by", "via", "in", "with", "and", "&", "+", "from", "paid", "spent", "spend", "total", "amt", "amount"}
_LEADING |= {"using", "through", "rs", "inr", "rupees", "₹"}
#: How people tell Rico: "I paid 80 for an auto" is "Auto", "we spent 900 on dinner" is "Dinner".
_LEADING |= {"i", "we", "just", "have", "had", "i've", "ive", "we've", "bought", "buy", "gave", "give", "got", "a", "an", "the", "my", "our"}
_TRAILING = (_LEADING - {"spent", "spend"}) | {"the", "a", "an", "near", "each", "only"}

_PAYMENT_PHRASES = {
    "company": r"corporate\s+card|company\s+card|office\s+card|(?:office|company)\s+paid|paid\s+by\s+(?:the\s+)?(?:office|company|employer)"
    r"|bill(?:ed)?\s+to\s+(?:the\s+)?(?:company|office)|corporate|company",
    "wallet": r"reroute\s+wallet|paytm\s+wallet|wallet",
    "upi": r"bhim\s+upi|google\s+pay|g\s?pay|phone\s?pe|paytm|bhim|upi",
    "card": r"(?:credit|debit)\s+card|master\s?card|american\s+express|visa|amex|rupay|card",
    "cash": r"cash",
}
#: Taxes paid as the expense itself: "toll tax 100", "state entry tax 300".
_LEVIES = {"toll", "road", "entry", "green", "state", "permit", "border", "municipal", "tourist", "vehicle"}
#: A "metro card" or "SIM card" is a thing bought, not how it was paid.
_CARD_THINGS = {"metro", "smart", "travel", "gift", "sim", "visiting", "business", "boarding", "memory", "greeting", "sd", "id", "access", "key"}

#: Words that may follow an amount: "350 at Truffles", "4500 incl GST". Any other word after a small number counts things.
_JOINS = {"at", "on", "to", "for", "from", "in", "by", "via", "with", "and", "incl", "including", "inclusive", "excl", "excluding", "plus"}
_JOINS |= {"paid", "only", "total", "approx", "per", "each", "near", "through", "using", "rs", "inr", "rupees"}
#: Units after a number: "100 pages", "12 km", "500 ml".
_UNITS = {
    "x", "pc", "pcs", "piece", "pieces", "no", "nos", "item", "items", "unit", "units", "page", "pages", "copy", "copies", "km", "kms",
    "kilometre", "kilometres", "kilometer", "kilometers", "hr", "hrs", "hour", "hours", "min", "mins", "minute", "minutes", "day",
    "days", "night", "nights", "person", "persons", "people", "pax", "ppl", "ml", "litre", "litres", "liter", "liters", "ltr", "kg",
    "kgs", "gm", "gms", "plate", "plates", "cup", "cups", "bottle", "bottles", "packet", "packets", "pkt", "trip", "trips",
}  # fmt: skip

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6,
    "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10, "nov": 11,
    "november": 11, "dec": 12, "december": 12,
}  # fmt: skip
_MON = "|".join(sorted(_MONTHS, key=len, reverse=True))

# ---------- patterns ----------

#: A number of rupees as typed: "350", "1,240", "1,50,000", "612.50".
_NUM = r"[0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?"
#: Not the start of a longer token: "6E", "3.2.1", "15/10".
_END = r"(?!\w|[.,/-][0-9])"

_GSTIN_SPAN = re.compile(
    r"(?:\bgst(?:in|\s*(?:no|num|number|reg(?:istration)?(?:\s*no)?)\b\.?)?\s*[:#.-]?\s*)?"
    r"\b(?P<id>[0-9]{2}[a-z]{5}[0-9]{4}[a-z][1-9a-z]z[0-9a-z])\b",
    re.I,
)
_PERCENT = re.compile(r"(?<![\w.])[0-9]+(?:\.[0-9]+)?\s*(?:%|per\s*cent\b)", re.I)
_DATE = re.compile(
    r"(?:\b(?:on|dated)\s+)?(?:"
    r"(?P<rel>\bday[\s-]+before[\s-]+yesterday\b|\byesterday\b|\byday\b|\btoday\b)"
    rf"|\b(?P<d1>[0-9]{{1,2}})(?:st|nd|rd|th)?[\s-]*(?:of\s+)?(?P<m1>{_MON})\b\.?(?:[\s,-]*(?P<y1>20[0-9]{{2}})\b|\s*'(?P<y1s>[0-9]{{2}})\b)?"
    rf"|\b(?P<m2>{_MON})\b\.?\s*(?P<d2>[0-9]{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s*(?P<y2>20[0-9]{{2}})\b)?"
    r"|\b(?P<iy>20[0-9]{2})-(?P<im>[0-9]{1,2})-(?P<id>[0-9]{1,2})\b"
    r"|\b(?P<d3>[0-9]{1,2})(?P<sep>[/-])(?P<m3>[0-9]{1,2})(?:(?P=sep)(?P<y3>[0-9]{4}|[0-9]{2}))?\b(?![/-][0-9])"
    r"|\b(?P<d4>[0-9]{1,2})\.(?P<m4>[0-9]{1,2})\.(?P<y4>[0-9]{4}|[0-9]{2})\b"
    r")",
    re.I,
)
_TIME = re.compile(
    r"(?:(?:\b(?:at|by|around|till|until)|@)\s*)?(?<![\w.,/])"
    r"(?:(?:1[0-2]|0?[1-9])(?:[:.][0-5][0-9])?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?![0-9]))",
    re.I,
)
_TAX_KIND = r"(?P<kind>c?gst|sgst|igst|utgst|tax(?:es)?|vat)"
_TAX_HOW = r"\b(?:incl(?:uding|usive(?:\s+of)?)?|excl(?:uding|usive(?:\s+of)?)?|plus|with)\b\.?\s*|\+\s*"
#: "GST 540", "incl. GST 54", "+ GST 720", "CGST 270".
_TAX_AFTER = re.compile(rf"(?P<how>{_TAX_HOW})?\b{_TAX_KIND}\b\s*(?:of|amt|amount|is)?\s*[:=@-]?\s*(?:₹|rs\.?|inr)?\s*(?P<num>{_NUM}){_END}", re.I)
#: "incl 540 GST", "+ 720 GST".
_TAX_BEFORE = re.compile(rf"(?P<how>{_TAX_HOW})(?:₹|rs\.?|inr)?\s*(?P<num>{_NUM})\s*(?:rs\.?|/-)?\s*\b{_TAX_KIND}\b", re.I)
#: What's left of tax talk once its numbers are taken: "incl GST", "inclusive of all taxes".
_TAX_WORDS = re.compile(
    r"\b(?:incl(?:uding|usive(?:\s+of)?)?|excl(?:uding|usive(?:\s+of)?)?)\b\.?|\b(?:all\s+)?(?P<kind>c?gst|sgst|igst|utgst|taxes|tax)\b",
    re.I,
)
_PAYMENT = re.compile(
    r"(?P<how>(?:\bpaid\s+)?\b(?:by|via|using|with|through|thru|in|on|from)\s+|\bpaid\s+)?"
    r"\b(?:" + "|".join(f"(?P<{k}>{v})" for k, v in _PAYMENT_PHRASES.items()) + r")\b"
    r"(?:\s+(?:paid|payment|pay|txn)\b)?",
    re.I,
)
_MONEY = re.compile(
    r"(?:(?P<pre>₹|(?<![\w.,/#*])(?:rs\.?|inr|rupees?))\s*|(?<![\w.,/#*₹]))"
    rf"(?P<num>{_NUM})"
    r"(?:\s*(?P<mult>k|thousand|lakhs?|lacs?|(?-i:L))(?!\w))?"
    r"(?P<suf>\s*/-|\s*(?:rs\.?|rupees?|inr|₹)(?![a-z])|\s+only\b)?"
    rf"{_END}",
    re.I,
)
#: Words that mark the number after them as what was paid: "total 4720", "auto fare 80".
_AMOUNT_WORD = re.compile(r"\b(?:total|tot|amt|amount|paid|bill|billed|spent|cost|price|fare|charges?)\s*[:=-]?\s*$", re.I)
#: Of those, the ones that go with the amount rather than stay in the title.
_AMOUNT_LEAD = re.compile(r"\b(?:total|tot|amt|amount|paid|spent)\s*[:=-]?\s*$", re.I)
#: Words a number after may name rather than price: "train 12627", "room no. 304".
_ID_WORDS = {"train", "flight", "bus", "room", "pnr", "no", "number", "seat", "coach", "platform", "table", "order", "booking", "invoice"}
_ID_WORDS |= {"route", "gate", "terminal", "berth", "flat", "door", "floor", "sector", "block"}
_ID_BEFORE = re.compile(r"([^\W\d_]+)[\s.#:-]*$")
_NEXT_WORD = re.compile(r"\s*([^\W\d_]+)")
_LAST_WORD = re.compile(r"([^\W\d_]+)[\s-]*$")
_PLAIN = str.maketrans({"–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "×": "x"})


# ---------- reading a line ----------


def _parse(text: str, today: date, memory: Mapping[str, tuple[str, str | None]] | None) -> ExpenseDraft:
    if isinstance(today, datetime):
        today = today.date()
    s = _normalise(text)

    # Each thing found is blanked out (same length, so later positions hold); what's left becomes the title.
    gstin = None
    for m in _GSTIN_SPAN.finditer(s):
        gstin = gstin or m.group("id").upper()
        s = _blank(s, m.start(), m.end())
    s = _PERCENT.sub(_blanks, s)

    day = None
    for m in _DATE.finditer(s):
        found = _date_in(m, today)
        if found is None:
            continue
        said, end = found
        day = day or said
        s = _blank(s, m.start(), end)
    s = _TIME.sub(_blanks, s)

    taxes: list[tuple[str, int, bool]] = []
    for pattern in (_TAX_AFTER, _TAX_BEFORE):
        for m in pattern.finditer(s):
            if _is_levy(m, s):
                continue
            paise = _paise(Decimal(m.group("num").replace(",", "")))
            how = (m.group("how") or "").strip().lower()
            taxes.append((m.group("kind").lower(), paise, how.startswith(("excl", "plus", "+"))))
            s = _blank(s, m.start(), m.end())
    s = _TAX_WORDS.sub(lambda m: m.group() if _is_levy(m, s) else _blanks(m), s)

    payment = None
    for m in _PAYMENT.finditer(s):
        kind = next(k for k in PAYMENTS if m.group(k))
        if not m.group("how") and not _is_payment(kind, m, s):
            continue
        payment = payment or kind
        s = _blank(s, m.start(), m.end())

    amount = None
    best: tuple[tuple[int, Decimal], re.Match[str]] | None = None
    for m in _MONEY.finditer(s):
        rupees = _rupees(m)
        if rupees is None or not 0 < rupees < TOO_MUCH_RUPEES:
            continue
        rank = (_rank(m, s, rupees), rupees)
        if best is None or rank > best[0]:
            best = (rank, m)
    if best is not None:
        (_, rupees), m = best
        amount = _paise(rupees)
        lead = _AMOUNT_LEAD.search(s[: m.start()])
        s = _blank(s, lead.start() if lead else m.start(), m.end())

    tax, added = _tax(taxes)
    if amount is not None and tax and added:
        amount += tax  # "4000 + GST 720" is 4720 in all
    if tax is not None and (tax <= 0 or (amount is not None and tax >= amount)):
        tax = None

    tokens = [t for t in s.split() if any(ch.isalnum() for ch in t) or t in ("&", "+", "@")]
    merchant = None
    remembered: tuple[str | None, str | None] = (None, None)
    found_merchant = _merchant_in(tokens, memory)
    if found_merchant:
        start, end, merchant = found_merchant
        remembered = _recall(tokens[start:end], memory)
        tokens[start:end] = [merchant]

    category = _category(re.findall(r"[^\W_]+", " ".join(tokens).replace("'", "").lower()))
    category = category or remembered[0]
    payment = payment or remembered[1]

    title = " ".join(_tidy(tokens))
    title = re.sub(r"\s+([,.;:!?])", r"\1", title).strip(" ,.;:-/|")
    # A title with no letters left ("", "0", "!!!") says nothing: the category's name says more.
    title = (title[:1].upper() + title[1:])[:120].rstrip() if any(ch.isalpha() for ch in title) else category_title(category)
    return ExpenseDraft(title=title, amount_paise=amount, tax_paise=tax, category=category, payment=payment, day=day, gstin=gstin, merchant=merchant)


def _normalise(text: str) -> str:
    if not isinstance(text, str):
        return ""
    s = unicodedata.normalize("NFKC", text[: LONGEST_TEXT * 2])[:LONGEST_TEXT].translate(_PLAIN)
    s = "".join(ch if ch.isprintable() else " " for ch in s)
    return re.sub(r"(?<!\S)@(?=\S)", "@ ", s)  # "@Truffles" is "at Truffles"


def _blank(s: str, start: int, end: int) -> str:
    return s[:start] + " " * (end - start) + s[end:]


def _blanks(m: re.Match[str]) -> str:
    return " " * len(m.group())


def _paise(rupees: Decimal) -> int:
    return int((rupees * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


# ---------- dates ----------


def _date_in(m: re.Match[str], today: date) -> tuple[date | None, int] | None:
    """The day a date match names and where its words end. None when it isn't a date after all ("45/80"); a month
    name with an impossible day ("31 Feb") is still taken out of the title, with no day."""
    g = m.groupdict()
    if g["rel"]:
        rel = g["rel"].lower()
        back = 0 if rel == "today" else 2 if rel.startswith("day") else 1
        return today - timedelta(days=back), m.end()
    if g["m1"] or g["m2"]:
        month = _MONTHS[(g["m1"] or g["m2"]).lower()]
        number = int(g["d1"] or g["d2"])
        year_group = "y1" if g["y1"] else "y1s" if g["y1s"] else "y2" if g["y2"] else None
        if year_group is None:
            return _on(number, month, None, today), m.end()
        year = int(g[year_group]) + (2000 if year_group == "y1s" else 0)
        if abs(year - today.year) > 1:
            # "Hotel 15 Oct 2000" is ₹2000 on 15 October, not a day in the year 2000.
            return _on(number, month, None, today), m.start(year_group) - (1 if year_group == "y1s" else 0)
        return _on(number, month, year, today), m.end()
    if g["iy"]:
        number, month, year = int(g["id"]), int(g["im"]), int(g["iy"])
    elif g["d3"]:
        number, month = int(g["d3"]), int(g["m3"])
        year = None if g["y3"] is None else int(g["y3"]) + (2000 if len(g["y3"]) == 2 else 0)
    else:
        number, month, year = int(g["d4"]), int(g["m4"]), int(g["y4"]) + (2000 if len(g["y4"]) == 2 else 0)
    if not (1 <= number <= 31 and 1 <= month <= 12):
        return None
    return _on(number, month, year, today), m.end()


def _on(number: int, month: int, year: int | None, today: date) -> date | None:
    """A day of a month. Without a year it's the latest one not after today: in January, "15 Dec" was last year."""
    if year is not None:
        try:
            return date(year, month, number)
        except ValueError:
            return None
    for y in (today.year, today.year - 1):
        try:
            d = date(y, month, number)
        except ValueError:
            continue
        if d <= today:
            return d
    return None


# ---------- payment, amount, tax ----------


def _is_payment(kind: str, m: re.Match[str], s: str) -> bool:
    """A bare payment word that is really part of something else: a "metro card", a "company office"."""
    said = m.group(kind).lower()
    if said == "card":
        before = _LAST_WORD.search(s[: m.start()])
        return not (before and before.group(1).lower() in _CARD_THINGS)
    if said in ("company", "corporate"):
        after = _NEXT_WORD.match(s[m.end() :])
        return not (after and after.group(1).lower() not in ("account", "expense", "expenses"))
    return True


def _is_levy(m: re.Match[str], s: str) -> bool:
    """A "toll tax" or "road tax" is the expense itself, not GST on it."""
    if not (m.group("kind") or "").lower().startswith("tax"):
        return False
    before = _LAST_WORD.search(s[: m.start("kind")])
    return bool(before and before.group(1).lower() in _LEVIES)


def _rupees(m: re.Match[str]) -> Decimal | None:
    try:
        value = Decimal(m.group("num").replace(",", ""))
    except InvalidOperation:
        return None
    mult = (m.group("mult") or "").lower()
    if mult in ("k", "thousand"):
        value *= 1000
    elif mult.startswith(("lakh", "lac")) or mult == "l":
        value *= 100_000
    return value


def _rank(m: re.Match[str], s: str, rupees: Decimal) -> int:
    """How surely a number is the amount: 3 when marked as money ("₹350", "3.2k", "total 4720"), 1 when it seems to
    count things ("2 coffees", "100 pages") or name one ("train 12627"), else 2. The best rank wins, then the larger
    number (the total). A rank-1 number is still the amount when it's the only one: "350 lunch", "bus 45"."""
    if m.group("pre") or m.group("suf") or m.group("mult") or _AMOUNT_WORD.search(s[: m.start()]):
        return 3
    small = rupees <= COUNTS_UP_TO and "." not in m.group("num")
    before = _ID_BEFORE.search(s[: m.start()])
    if before and (before.group(1).lower() in _ID_WORDS or (small and before.group(1).lower() == "for")):
        return 1  # "Train 12627 450", "Room 304 1200", "Dinner for 4": a number, not the price
    after = _NEXT_WORD.match(s[m.end() :])
    word = after.group(1).lower() if after else None
    if word in _UNITS:
        return 1
    if word and word not in _JOINS and small:
        return 1
    return 2


def _tax(taxes: list[tuple[str, int, bool]]) -> tuple[int | None, bool]:
    """The GST said, and whether it comes on top of the amount ("+ GST 720"). CGST and SGST add up."""
    whole = [t for t in taxes if t[0] in ("gst", "igst", "tax", "taxes", "vat")]
    if whole:
        return whole[0][1], whole[0][2]
    if taxes:
        return sum(t[1] for t in taxes), taxes[0][2]  # in "CGST 225 + SGST 225" the "+" joins the two
    return None, False


# ---------- merchant, category, title ----------


def _bare(token: str) -> str:
    return token.lower().strip(".,;:!?()[]\"'")


def _merchant_in(tokens: list[str], memory: Mapping[str, tuple[str, str | None]] | None) -> tuple[int, int, str] | None:
    """Where the merchant is among the title's words, and its name: after "at" ("at Truffles"), else a company it
    knows ("Uber"), else one the traveller has used before."""
    words = [_bare(t) for t in tokens]
    for i, w in enumerate(words):
        if w not in ("at", "@"):
            continue
        j = i + 1
        while j < len(tokens) and j <= i + 5 and words[j] not in _STOPS:
            j += 1
        if j > i + 1 and not all(words[k] in _GENERIC_PLACES for k in range(i + 1, j)):
            return i + 1, j, _display(" ".join(tokens[i + 1 : j]))
    for i in range(len(tokens)):
        for n in (2, 1):
            key = merchant_key("".join(tokens[i : i + n]))
            if i + n <= len(tokens) and key in _BRANDS:
                return i, i + n, _BRANDS[key]
    if memory:
        for n in range(min(4, len(tokens)), 0, -1):
            for i in range(len(tokens) - n + 1):
                if words[i] in _STOPS or words[i + n - 1] in _STOPS:
                    continue
                key = merchant_key(" ".join(tokens[i : i + n]))
                if len(key) >= 2 and key in memory:
                    return i, i + n, _display(" ".join(tokens[i : i + n]))
    return None


def _display(name: str) -> str:
    """A merchant's name as typed, with capitals if it was typed all in lower case: "truffles" is "Truffles"."""
    name = name.strip(" .,;:!?-'\"()")
    if name == name.lower():
        name = " ".join(w[:1].upper() + w[1:] for w in name.split())
    return name[:80]


def _recall(tokens: list[str], memory: Mapping[str, tuple[str, str | None]] | None) -> tuple[str | None, str | None]:
    """The category and payment remembered for a merchant: its whole name, else the longest part of it remembered
    ("Truffles Koramangala" finds Truffles). Anything that isn't a category or payment is ignored."""
    if not memory:
        return None, None
    for n in range(len(tokens), 0, -1):
        for i in range(len(tokens) - n + 1):
            key = merchant_key(" ".join(tokens[i : i + n]))
            if len(key) < 2 or key not in memory:
                continue
            try:
                category, payment = memory[key]
            except (TypeError, ValueError):
                return None, None
            return (category if category in CATEGORIES else None), (payment if payment in PAYMENTS else None)
    return None, None


def _keyword(word: str) -> str | None:
    for form in (word, word[:-2] if word.endswith("es") else "", word[:-1] if word.endswith("s") else ""):
        if form and form in _KEYWORDS:
            return _KEYWORDS[form]
    return None


def _category(words: list[str]) -> str | None:
    """The first word that names a kind of expense. "Hotel" and "ticket" count only when nothing else does, and a
    client's or the team's meal (or a gift) is "client"."""
    strong: list[str] = []
    weak: list[str] = []
    client = False
    for i, w in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else ""
        if w in _CLIENT_WORDS or (w == "team" and nxt in _MEALS):
            client = True
        cat = _KEYWORDS.get(f"{w} {nxt}") or _keyword(w)
        if cat:
            strong.append(cat)
        elif w in _WEAK or w.rstrip("s") in _WEAK:
            weak.append(_WEAK.get(w) or _WEAK[w.rstrip("s")])
    first = strong[0] if strong else None
    if client and first in (None, "food"):
        return "client"
    return first or (weak[0] if weak else None)


def _tidy(tokens: list[str]) -> list[str]:
    """Drop the little words left hanging once the amount and the rest are out: "Lunch at" is "Lunch"."""
    out: list[str] = []
    for t in tokens:
        if out and _bare(t) in _STOPS and _bare(t) == _bare(out[-1]):
            continue  # "at at", left by a time between them
        out.append(t)
    while out and _bare(out[0]) in _LEADING:
        out.pop(0)
    while out and _bare(out[-1]) in _TRAILING:
        out.pop()
    return out
