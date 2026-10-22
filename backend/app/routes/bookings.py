"""Simulated bookings: a train ticket for a train task, a cab for a leg. A demo: nothing real is booked or charged.

Like the demo clock, these routes exist only with DEMO_LOGIN=true; otherwise every one answers 404.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.clock import minutes_of_day, tz_for
from app.deps import CurrentUser, Db, OwnedTrip, demo_only
from app.errors import ApiError
from app.models import Booking, Task, Trip
from app.schemas import BookingIn, BookingOut, CabOptionOut, PostBody, TrainClassOut, TrainOptionOut
from app.services import booking_sim as sim
from app.services import plan_store

router = APIRouter(prefix="/v1", tags=["bookings"], dependencies=[Depends(demo_only)])


def _task(db, trip: Trip, task_id: str | None) -> Task:
    task = db.get(Task, task_id) if task_id else None
    if task is None or task.trip_id != trip.trip_id:
        raise ApiError(404, "Task not found.")
    return task


def _origin(task: Task) -> str:
    name = task.place.name if task.place else ""
    return name if "station" in name.lower() else f"{name or 'Bengaluru'} station"


def _trains(trip: Trip, task: Task, destination: str) -> list[sim.TrainOption]:
    tz = tz_for(trip.utc_offset)
    around = minutes_of_day(task.fixed_start, task.day, tz) if task.fixed_start else 18 * 60
    return sim.train_options(trip.trip_id, str(task.day), _origin(task), destination, around)


def _train_out(t: sim.TrainOption) -> TrainOptionOut:
    return TrainOptionOut(
        train_no=t.train_no,
        name=t.name,
        origin=t.origin,
        destination=t.destination,
        departs=sim.hhmm(t.departs),
        arrives=sim.hhmm(t.arrives),
        arrives_next_day=t.arrives // (24 * 60),
        duration_min=t.duration_min,
        classes=[TrainClassOut(code=c.code, label=c.label, fare_inr=c.fare_inr, status=c.status, availability=c.availability) for c in t.classes],
    )


def _leg_fare(db, trip: Trip, to_id: str) -> int:
    """The cab fare of the active plan's leg to `to_id`, or an estimate from its travel time."""
    plan = plan_store.active_plan(db, trip.trip_id)
    legs = [*(plan.legs if plan else []), *((plan.done_legs or []) if plan else [])]
    leg = next((x for x in legs if (x.get("taskId") or "end") == to_id), None)
    if leg is None:
        raise ApiError(404, "That leg isn't in your plan.")
    return leg["fareInr"] if leg.get("mode") == "cab" and leg.get("fareInr") else max(80, round(leg.get("travelMin", 20) * 9))


def _out(b: Booking) -> BookingOut:
    return BookingOut.model_validate(b)


@router.get("/trips/{trip_id}/bookings", response_model=list[BookingOut], response_model_by_alias=True, summary="Your simulated tickets and rides")
def list_bookings(trip: OwnedTrip, db: Db) -> list[BookingOut]:
    rows = db.scalars(select(Booking).where(Booking.trip_id == trip.trip_id).order_by(Booking.created_at.desc()))
    return [_out(b) for b in rows]


@router.get(
    "/trips/{trip_id}/train-options", response_model=list[TrainOptionOut], response_model_by_alias=True, summary="Sample trains for a train task (demo)"
)
def train_options(
    trip: OwnedTrip,
    db: Db,
    task_id: Annotated[str, Query(alias="taskId")],
    to: Annotated[str, Query(min_length=2, max_length=60)],
) -> list[TrainOptionOut]:
    return [_train_out(t) for t in _trains(trip, _task(db, trip, task_id), to)]


@router.get("/trips/{trip_id}/cab-options", response_model=list[CabOptionOut], response_model_by_alias=True, summary="Cab choices for a leg (demo)")
def cab_options(trip: OwnedTrip, db: Db, to_id: Annotated[str, Query(alias="toId", max_length=40)]) -> list[CabOptionOut]:
    options = sim.cab_options(trip.trip_id, to_id, _leg_fare(db, trip, to_id))
    return [
        CabOptionOut(
            option_id=o.option_id,
            provider=o.provider,
            provider_label=o.provider_label,
            vehicle=o.vehicle,
            vehicle_label=o.vehicle_label,
            seats=o.seats,
            eta_min=o.eta_min,
            fare_inr=o.fare_inr,
        )
        for o in options
    ]


@router.post(
    "/trips/{trip_id}/bookings", response_model=BookingOut, response_model_by_alias=True, status_code=201, summary="Book a train ticket or a cab (simulated)"
)
def create_booking(body: BookingIn, trip: OwnedTrip, user: CurrentUser, db: Db) -> BookingOut:
    seed = f"{trip.trip_id}|{body.idempotency_key}"
    if body.kind == "train":
        task = _task(db, trip, body.task_id)
        if not body.destination or not body.train_no or not body.travel_class or not body.passengers:
            raise ApiError(422, "Choose where to, a train, a class and who's travelling.", code="VALIDATION_ERROR")
        train = next((t for t in _trains(trip, task, body.destination) if t.train_no == body.train_no), None)
        cls = next((c for c in train.classes if c.code == body.travel_class), None) if train else None
        if train is None or cls is None:
            raise ApiError(422, "That train or class isn't on offer. Search again.", code="VALIDATION_ERROR")
        pnr, passengers, overall = sim.book_train(train, cls.code, [p.model_dump() for p in body.passengers], seed)
        booking = Booking(
            trip_id=trip.trip_id,
            kind="train",
            task_id=task.task_id,
            provider="irctc",
            reference=pnr,
            fare_inr=cls.fare_inr * len(passengers),
            details={
                "trainNo": train.train_no,
                "trainName": train.name,
                "origin": train.origin,
                "destination": train.destination,
                "date": str(task.day),
                "departs": sim.hhmm(train.departs),
                "arrives": sim.hhmm(train.arrives),
                "arrivesNextDay": train.arrives // (24 * 60),
                "travelClass": cls.code,
                "classLabel": cls.label,
                "bookingStatus": overall,
                "passengers": passengers,
            },
        )
    else:
        if not body.to_id or not body.option_id:
            raise ApiError(422, "Choose a ride for the leg.", code="VALIDATION_ERROR")
        option = next((o for o in sim.cab_options(trip.trip_id, body.to_id, _leg_fare(db, trip, body.to_id)) if o.option_id == body.option_id), None)
        if option is None:
            raise ApiError(422, "That ride isn't on offer any more. Choose again.", code="VALIDATION_ERROR")
        driver = sim.assign_driver(option, seed)
        booking = Booking(
            trip_id=trip.trip_id,
            kind="cab",
            to_id=body.to_id,
            provider=option.provider,
            reference=f"{option.provider[:2].upper()}{driver['otp']}{seed[-4:].upper()}",
            fare_inr=option.fare_inr,
            details={"providerLabel": option.provider_label, "vehicle": option.vehicle, "vehicleLabel": option.vehicle_label, **driver},
        )
    db.add(booking)
    db.commit()
    db.refresh(booking)
    return _out(booking)


@router.post("/trips/{trip_id}/bookings/{booking_id}/cancel", response_model=BookingOut, response_model_by_alias=True, summary="Cancel a simulated booking")
def cancel_booking(booking_id: str, body: PostBody, trip: OwnedTrip, db: Db) -> BookingOut:
    booking = db.get(Booking, booking_id)
    if booking is None or booking.trip_id != trip.trip_id:
        raise ApiError(404, "Booking not found.")
    if booking.status != "cancelled":
        booking.status = "cancelled"
        # A demo refund: trains keep a small clerkage, cabs cancelled before pickup refund in full.
        refund = max(0, booking.fare_inr - 60 * len(booking.details.get("passengers", []))) if booking.kind == "train" else booking.fare_inr
        booking.details = {**booking.details, "refundInr": refund}
        db.commit()
        db.refresh(booking)
    return _out(booking)
