"""Request and response bodies. JSON is camelCase; times of day are "HH:MM"; money is whole rupees."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

VehicleType = Literal["shared_auto", "e_rickshaw", "tempo"]
RouteStatus = Literal["unverified", "verified", "stale"]
RouteSource = Literal["stands_tapped", "gps_ride", "import"]
ContributionStatus = Literal["waiting", "verified", "rejected", "merged"]
FareReportStatus = Literal["waiting", "accepted", "rejected"]
HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", examples=["21:30"])]
IdempotencyKey = Annotated[str, Field(min_length=8, max_length=128, examples=["con-7f3a91c2"])]
Fare = Annotated[int, Field(ge=0, le=2000)]
T = TypeVar("T")


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Location(ApiModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class StandOut(ApiModel):
    stand_id: str
    name: str
    location: Location
    sample: bool = False


class StandNear(StandOut):
    distance_m: float


class RouteStandOut(StandOut):
    seq: int


class RouteOut(ApiModel):
    route_id: str
    city_slug: str
    stands: list[RouteStandOut]
    path: list[Location]
    vehicle_type: VehicleType
    fare_inr: int = Field(description="The most common accepted fare reported in the last 30 days, else the route's own fare.")
    frequency_min: int
    first_trip: HHMM
    last_trip: HHMM
    status: RouteStatus
    source: RouteSource
    confidence: float
    last_confirmed_at: str | None
    confirmations_count: int
    sample: bool


class StandRef(ApiModel):
    stand_id: str
    name: str
    seq: int
    location: Location


class LegOptionOut(ApiModel):
    route_id: str
    vehicle_type: VehicleType
    status: RouteStatus
    fare_inr: int
    frequency_min: int
    first_trip: HHMM
    last_trip: HHMM
    board: StandRef
    alight: StandRef
    stops_between: int
    walk_from_m: float
    walk_to_m: float
    walk_from_min: int
    walk_to_min: int
    expected_wait_min: int
    ride_distance_m: float
    sample: bool


class LegOptionsOut(ApiModel):
    items: list[LegOptionOut] = Field(description="Verified, current routes. Only these may be a main option.")
    extras: list[LegOptionOut] = Field(description="Unverified or stale routes, shown only as labelled extras.")
    last_trip_passed: list[str] = Field(description="Routes that serve both ends but whose last trip has gone.")
    next_cursor: str | None = None


class Page(ApiModel, Generic[T]):  # noqa: UP046  (explicit Generic keeps pydantic's generic models predictable)
    items: list[T]
    next_cursor: str | None


class NewStand(ApiModel):
    name: str = Field(min_length=2, max_length=160)
    location: Location


class TappedStand(ApiModel):
    """An existing stand by ID, or a new one by name and location."""

    stand_id: str | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, min_length=2, max_length=160)
    location: Location | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> TappedStand:
        if self.stand_id is None and (self.name is None or self.location is None):
            raise ValueError("give a standId, or a name and a location")
        return self


class GpsPoint(ApiModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    t: datetime


class ContributionIn(ApiModel):
    idempotency_key: IdempotencyKey
    city_slug: str = Field(default="bengaluru", min_length=2, max_length=64, pattern=r"^[a-z0-9-]+$")
    kind: Literal["stands_tapped", "gps_ride"]
    vehicle_type: VehicleType
    fare_inr: Fare
    frequency_min: int = Field(ge=1, le=180)
    first_trip: HHMM
    last_trip: HHMM
    stands: list[TappedStand] | None = Field(default=None, max_length=40)
    points: list[GpsPoint] | None = Field(default=None, max_length=20000)

    @model_validator(mode="after")
    def _shape(self) -> ContributionIn:
        if self.first_trip >= self.last_trip:
            raise ValueError("lastTrip must be after firstTrip")
        if self.kind == "stands_tapped" and (not self.stands or len(self.stands) < 2):
            raise ValueError("a route needs at least two stands, in the order the vehicle stops")
        if self.kind == "gps_ride" and (not self.points or len(self.points) < 2):
            raise ValueError("a recorded ride needs GPS points")
        return self


class ContributionOut(ApiModel):
    contribution_id: str
    kind: str
    status: ContributionStatus
    route_id: str | None
    contributor_id: str | None
    reject_reason: str | None
    created_at: str
    decided_at: str | None
    payload: dict
    route: RouteOut | None = None
    suggested_stands: list[Location] = Field(default_factory=list, description="Places a recorded ride stood still for 30 s or more.")


class ContributionDecision(ApiModel):
    action: Literal["approve", "edit", "reject"]
    reason: str | None = Field(default=None, min_length=3, max_length=500)
    vehicle_type: VehicleType | None = None
    fare_inr: Fare | None = None
    frequency_min: int | None = Field(default=None, ge=1, le=180)
    first_trip: HHMM | None = None
    last_trip: HHMM | None = None

    @model_validator(mode="after")
    def _reason_for_reject(self) -> ContributionDecision:
        if self.action == "reject" and not self.reason:
            raise ValueError("a rejection needs a reason")
        return self


class ConfirmationIn(ApiModel):
    idempotency_key: IdempotencyKey


class ConfirmationOut(ApiModel):
    route_id: str
    status: RouteStatus
    last_confirmed_at: str | None
    confirmations_count: int


class FareReportIn(ApiModel):
    idempotency_key: IdempotencyKey
    fare_inr: Fare


class FareReportOut(ApiModel):
    fare_report_id: str
    route_id: str
    user_id: str
    fare_inr: int
    status: FareReportStatus
    at: str
    decided_at: str | None


class FareReportDecision(ApiModel):
    action: Literal["accept", "reject"]


class Health(ApiModel):
    status: Literal["ok"]
    service: Literal["raasta"]
