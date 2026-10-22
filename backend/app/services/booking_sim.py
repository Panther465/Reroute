"""A simulated booking system for trains, flights and cabs (a class-project demo).

The partners are invented (RailGo trains, SkyHop flights, RideNow, AutoGo and ZipBike rides): nothing
here talks to a real railway, airline or ride app, and the wallet that pays holds simulated money.
Options are generated deterministically from the trip, so the same search always shows the same
choices, and a booking is checked against them on the server (the app can't set its own fare). Every
answer says it's a demo.
"""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass, field
from datetime import date

#: Travel classes, with a sample fare per 100 km (rupees).
CLASSES: dict[str, tuple[str, int]] = {
    "SL": ("Sleeper", 45),
    "3A": ("AC 3 tier", 115),
    "2A": ("AC 2 tier", 165),
    "1A": ("AC first class", 275),
    "CC": ("AC chair car", 95),
}
COACH = {"SL": "S", "3A": "B", "2A": "A", "1A": "H", "CC": "C"}
BERTHS = ["Lower", "Middle", "Upper", "Side lower", "Side upper"]
KINDS = ["Express", "Superfast Express", "Mail", "Shatabdi Express"]

#: Invented ride partners, and the vehicles each offers.
PROVIDERS = {"ridenow": "RideNow", "autogo": "AutoGo", "zipbike": "ZipBike"}
FLEET = {"ridenow": ("mini", "sedan"), "autogo": ("auto",), "zipbike": ("bike",)}
#: The railway partner, as the booking records it.
RAIL = "railgo"
#: Vehicle: label, seats, fare factor against the leg's cab fare, extra wait minutes.
VEHICLES = {"bike": ("Bike", 1, 0.45, 1), "auto": ("Auto", 3, 0.7, 2), "mini": ("Mini", 4, 1.0, 3), "sedan": ("Sedan", 4, 1.3, 4)}
DRIVERS = ["Ravi Kumar", "Suresh Gowda", "Manjunath R", "Imran Pasha", "Prakash N", "Arun Shetty", "Venkatesh B", "Kiran Raj"]
CARS = {
    "bike": ["Honda Activa", "TVS Jupiter"],
    "auto": ["Bajaj RE auto", "Piaggio Ape"],
    "mini": ["Maruti WagonR", "Hyundai i10"],
    "sedan": ["Maruti Dzire", "Honda Amaze"],
}


def _rng(*parts: object) -> random.Random:
    seed = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return random.Random(int(seed[:16], 16))


def hhmm(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


@dataclass(frozen=True)
class TrainClass:
    code: str
    label: str
    fare_inr: int
    status: str  # available, rac or wl
    count: int

    @property
    def availability(self) -> str:
        return {"available": f"Available {self.count}", "rac": f"RAC {self.count}", "wl": f"Waiting list {self.count}"}[self.status]


@dataclass(frozen=True)
class TrainOption:
    train_no: str
    name: str
    origin: str
    destination: str
    departs: int
    duration_min: int
    classes: tuple[TrainClass, ...] = field(default_factory=tuple)

    @property
    def arrives(self) -> int:
        return self.departs + self.duration_min


def train_options(trip_id: str, day: str, origin: str, destination: str, around: int) -> list[TrainOption]:
    """Four sample trains leaving near `around` (minutes after midnight), for the same inputs always the same."""
    dest = destination.strip().title()
    rng = _rng("trains", trip_id, day, origin, dest.lower())
    km = rng.randint(250, 1400)
    out = []
    for i, offset in enumerate((-75, -25, 0, 40)):
        kind = KINDS[(i + rng.randint(0, 3)) % len(KINDS)]
        shatabdi = kind.startswith("Shatabdi")
        speed = 70 if shatabdi else rng.choice((52, 58, 64))
        classes = []
        for code in ("CC",) if shatabdi else ("SL", "3A", "2A", "1A"):
            label, per100 = CLASSES[code]
            roll = rng.random()
            status = "available" if roll < 0.6 else "rac" if roll < 0.8 else "wl"
            count = rng.randint(4, 120) if status == "available" else rng.randint(1, 40)
            classes.append(TrainClass(code, label, round(per100 * km / 100 / 5) * 5 + 40, status, count))
        out.append(
            TrainOption(
                train_no=str(rng.randint(12000, 22999)),
                name=f"{origin.split(' ')[0]}–{dest} {kind}",
                origin=origin,
                destination=dest,
                departs=max(0, around + offset + rng.randint(-5, 5)),
                duration_min=round(km / speed * 60 / 5) * 5,
                classes=tuple(classes),
            )
        )
    return sorted(out, key=lambda t: t.departs)


def book_train(train: TrainOption, code: str, passengers: list[dict], booking_seed: str) -> tuple[str, list[dict], str]:
    """A PNR and each passenger's status: a coach and berth when confirmed, else RAC or waiting list."""
    rng = _rng("pnr", booking_seed)
    cls = next(c for c in train.classes if c.code == code)
    pnr = str(rng.randint(10**9, 10**10 - 1))
    coach = f"{COACH[code]}{rng.randint(1, 9)}"
    seat = rng.randint(1, 64)
    out = []
    for n, p in enumerate(passengers):
        if cls.status == "available":
            out.append(
                {**p, "status": "Confirmed", "coach": coach, "berth": seat + n, "berthType": "Window" if code == "CC" else BERTHS[(seat + n) % len(BERTHS)]}
            )
        elif cls.status == "rac":
            out.append({**p, "status": f"RAC {cls.count + n}"})
        else:
            out.append({**p, "status": f"Waiting list {cls.count + n}"})
    overall = "Confirmed" if cls.status == "available" else "RAC" if cls.status == "rac" else "Waiting list"
    return pnr, out, overall


@dataclass(frozen=True)
class CabOption:
    option_id: str
    provider: str
    vehicle: str
    eta_min: int
    fare_inr: int

    @property
    def provider_label(self) -> str:
        return PROVIDERS[self.provider]

    @property
    def vehicle_label(self) -> str:
        return VEHICLES[self.vehicle][0]

    @property
    def seats(self) -> int:
        return VEHICLES[self.vehicle][1]


def cab_options(trip_id: str, to_id: str, base_fare: int) -> list[CabOption]:
    """Each provider's vehicles for one leg, priced from the leg's cab fare."""
    out = []
    for provider in PROVIDERS:
        rng = _rng("cab", trip_id, to_id, provider)
        for vehicle in FLEET[provider]:
            _label, _seats, factor, wait = VEHICLES[vehicle]
            fare = max(30, round(base_fare * factor * rng.uniform(0.9, 1.12) / 5) * 5)
            out.append(CabOption(f"{provider}-{vehicle}", provider, vehicle, wait + rng.randint(1, 6), fare))
    return sorted(out, key=lambda o: o.fare_inr)


def assign_driver(option: CabOption, booking_seed: str) -> dict:
    rng = _rng("driver", booking_seed)
    letters = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(2))
    return {
        "driverName": rng.choice(DRIVERS),
        "rating": round(rng.uniform(4.55, 4.97), 2),
        "vehicleModel": rng.choice(CARS[option.vehicle]),
        "plate": f"KA {rng.randint(1, 53):02d} {letters} {rng.randint(1000, 9999)}",
        "otp": f"{rng.randint(0, 9999):04d}",
        "etaMin": option.eta_min,
    }


# ---------- flights (SkyHop, an invented airline) ----------

AIRLINE = "SkyHop"
#: Airports SkyHop flies between: city, airport name, latitude, longitude.
AIRPORTS: dict[str, tuple[str, str, float, float]] = {
    "BLR": ("Bengaluru", "Kempegowda International", 13.199, 77.706),
    "DEL": ("Delhi", "Indira Gandhi International", 28.556, 77.100),
    "BOM": ("Mumbai", "Chhatrapati Shivaji Maharaj International", 19.090, 72.866),
    "MAA": ("Chennai", "Chennai International", 12.994, 80.171),
    "HYD": ("Hyderabad", "Rajiv Gandhi International", 17.240, 78.429),
    "CCU": ("Kolkata", "Netaji Subhas Chandra Bose International", 22.654, 88.447),
    "GOI": ("Goa", "Dabolim", 15.381, 73.831),
    "PNQ": ("Pune", "Pune", 18.582, 73.920),
    "COK": ("Kochi", "Cochin International", 10.152, 76.402),
    "AMD": ("Ahmedabad", "Sardar Vallabhbhai Patel International", 23.077, 72.635),
}
CABINS = {"economy": "Economy", "business": "Business"}


def km_between(a: str, b: str) -> float:
    """Great-circle distance between two airports."""
    _, _, lat1, lng1 = AIRPORTS[a]
    _, _, lat2, lng2 = AIRPORTS[b]
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class FlightFare:
    cabin: str
    fare_inr: int
    seats_left: int

    @property
    def label(self) -> str:
        return CABINS[self.cabin]


@dataclass(frozen=True)
class FlightOption:
    flight_no: str
    origin: str
    destination: str
    day: date
    departs: int
    duration_min: int
    stops: int
    fares: tuple[FlightFare, ...]

    @property
    def arrives(self) -> int:
        return self.departs + self.duration_min


def flight_options(origin: str, destination: str, day: date) -> list[FlightOption]:
    """Five sample SkyHop flights through the day, priced from the distance; the same inputs, the same flights."""
    km = km_between(origin, destination)
    rng = _rng("flights", origin, destination, day.isoformat())
    out = []
    for slot in (6 * 60 + 10, 9 * 60 + 35, 13 * 60 + 5, 17 * 60 + 40, 21 * 60 + 15):
        stops = 1 if rng.random() < 0.2 else 0
        duration = round((km / 780 * 60 + 35 + stops * 75) / 5) * 5
        economy = round((1800 + km * rng.uniform(2.2, 3.0)) / 10) * 10
        business = round(economy * rng.uniform(2.6, 3.2) / 10) * 10
        out.append(
            FlightOption(
                flight_no=f"SH {rng.randint(101, 989)}",
                origin=origin,
                destination=destination,
                day=day,
                departs=slot + rng.randint(-20, 20),
                duration_min=duration,
                stops=stops,
                fares=(FlightFare("economy", economy, rng.randint(2, 42)), FlightFare("business", business, rng.randint(1, 8))),
            )
        )
    return sorted(out, key=lambda f: f.departs)


def book_flight(flight: FlightOption, cabin: str, passengers: list[dict], booking_seed: str) -> tuple[str, list[dict]]:
    """A six-character PNR and a seat for each passenger, next to each other."""
    rng = _rng("pnr-flight", booking_seed)
    pnr = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
    row = rng.randint(1, 4) if cabin == "business" else rng.randint(8, 32)
    letters = "AC" if cabin == "business" else "ABCDEF"
    return pnr, [{**p, "seat": f"{row + i // len(letters)}{letters[i % len(letters)]}"} for i, p in enumerate(passengers)]
