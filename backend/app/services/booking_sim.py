"""A simulated booking system for trains and cabs (a class-project demo).

Nothing here talks to IRCTC, Uber, Ola or Rapido, and nothing is charged. Trains and cab options are
generated deterministically from the trip, so the same search always shows the same choices, and a
booking is checked against them on the server (the app can't set its own fare). Every answer says
it's a demo.
"""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass, field

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

PROVIDERS = {"uber": "Uber", "ola": "Ola", "rapido": "Rapido"}
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
        for vehicle, (_label, _seats, factor, wait) in VEHICLES.items():
            if vehicle == "bike" and provider != "rapido":
                continue
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
