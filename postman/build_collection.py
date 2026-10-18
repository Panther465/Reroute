"""Builds postman/reroute.postman_collection.json: every API request with tests and a response example.

The collection replays the golden demo day (project brief, section 16) against a running stack:
python postman/build_collection.py && npx newman run postman/reroute.postman_collection.json --insecure
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent


def body(data: dict) -> dict:
    return {"mode": "raw", "raw": json.dumps(data, indent=2), "options": {"raw": {"language": "json"}}}


def req(name: str, method: str, path: str, *, data: dict | None = None, tests: list[str] | None = None, auth: bool = True, example: dict | None = None, status: int = 200, pre: list[str] | None = None) -> dict:
    headers = [{"key": "Content-Type", "value": "application/json"}] if data is not None else []
    if auth:
        headers.append({"key": "Authorization", "value": "Bearer {{accessToken}}"})
    request = {"method": method, "header": headers, "url": {"raw": "{{baseUrl}}" + path, "host": ["{{baseUrl}}"], "path": [p for p in path.split("?")[0].split("/") if p]}}
    if "?" in path:
        request["url"]["query"] = [{"key": k, "value": v} for k, v in (kv.split("=", 1) for kv in path.split("?", 1)[1].split("&"))]
    if data is not None:
        request["body"] = body(data)
    item: dict = {"name": name, "request": request, "event": []}
    if pre:
        item["event"].append({"listen": "prerequest", "script": {"type": "text/javascript", "exec": pre}})
    checks = [f"pm.test('status {status}', () => pm.response.to.have.status({status}));", *(tests or [])]
    item["event"].append({"listen": "test", "script": {"type": "text/javascript", "exec": checks}})
    if example is not None:
        item["response"] = [
            {
                "name": f"{status} example",
                "originalRequest": request,
                "status": "OK" if status < 300 else "Error",
                "code": status,
                "_postman_previewlanguage": "json",
                "header": [{"key": "Content-Type", "value": "application/json"}],
                "body": json.dumps(example, indent=2, ensure_ascii=False),
            }
        ]
    return item


KEY = "{{$guid}}"

reroute = [
    req(
        "Demo sign-in",
        "POST",
        "/v1/auth/demo",
        data={"as": "traveller"},
        auth=False,
        tests=["const b = pm.response.json(); pm.collectionVariables.set('accessToken', b.accessToken);", "pm.test('demo user', () => pm.expect(b.user.isDemo).to.eql(true));"],
        example={"accessToken": "eyJhbGciOi…", "tokenType": "Bearer", "expiresIn": 900, "user": {"userId": "usr-demo-traveller", "email": "demo.traveller@reroute.example", "name": "Arjun Mehta (sample)", "role": "traveller", "isDemo": True}},
    ),
    req("Me", "GET", "/v1/me", tests=["pm.test('role', () => pm.expect(pm.response.json().role).to.eql('traveller'));"], example={"userId": "usr-demo-traveller", "role": "traveller"}),
    req("Reset the demo day", "POST", "/v1/trips/trip-001/demo/reset", data={"idempotencyKey": KEY}, example={"tripId": "trip-001", "activePlan": None}),
    req("List trips", "GET", "/v1/trips?limit=20", tests=["pm.test('demo trip', () => pm.expect(pm.response.json().items.map(t => t.tripId)).to.include('trip-001'));"], example={"items": [{"tripId": "trip-001", "cityName": "Bengaluru", "sample": True}], "nextCursor": None}),
    req("Search places", "GET", "/v1/places?q=Koramangala&city=bengaluru", tests=["pm.test('found', () => pm.expect(pm.response.json().length).to.be.above(0));"], example=[{"placeId": "koramangala-bank", "name": "Bank, 80 Feet Road", "area": "Koramangala", "sample": True}]),
    req("Set demo clock to 07:30", "POST", "/v1/trips/trip-001/demo/clock", data={"now": "2026-10-14T07:30:00+05:30", "idempotencyKey": KEY}),
    req(
        "Start planning",
        "POST",
        "/v1/trips/trip-001/plans",
        data={"idempotencyKey": KEY},
        status=202,
        tests=["pm.collectionVariables.set('jobId', pm.response.json().jobId);"],
        example={"jobId": "4f1c…", "status": "queued"},
    ),
    req(
        "Planning job status",
        "GET",
        "/v1/jobs/{{jobId}}",
        pre=["setTimeout(() => {}, 1500);"],
        tests=["pm.test('finished', () => pm.expect(pm.response.json().status).to.eql('finished'));"],
        example={"jobId": "4f1c…", "status": "finished", "planVersion": 1},
    ),
    req(
        "Plan version 1",
        "GET",
        "/v1/trips/trip-001/plans/1",
        tests=[
            "const p = pm.response.json(); const hm = s => s.slice(11, 16);",
            "pm.test('golden v1', () => pm.expect(p.legs.map(l => [hm(l.leaveBy), hm(l.taskStart)])).to.eql([['08:50','10:00'],['11:05','12:25'],['15:00','15:40'],['16:30','16:50']]));",
        ],
        example={
            "planId": "plan-001",
            "version": 1,
            "status": "active",
            "trigger": "created",
            "ruleVersion": "1.0",
            "legs": [{"seq": 1, "taskId": "task-meet", "mode": "metro", "label": "Metro, then shared auto", "leaveBy": "2026-10-14T08:50:00+05:30", "arriveAt": "2026-10-14T09:50:00+05:30", "travelMin": 60, "fareInr": 70}],
            "totals": {"travelMin": 200, "fareInr": 210, "waitMin": 0},
            "reasonCodes": ["RAASTA_VERIFIED"],
        },
    ),
    req("Set demo clock to 10:55", "POST", "/v1/trips/trip-001/demo/clock", data={"now": "2026-10-14T10:55:00+05:30", "idempotencyKey": KEY}),
    req(
        "Report a 40-minute delay",
        "POST",
        "/v1/trips/trip-001/checkins",
        data={"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": "{{checkinKey}}"},
        pre=["pm.collectionVariables.set('checkinKey', 'chk-' + Date.now());"],
        tests=[
            "const b = pm.response.json();",
            "pm.test('options', () => pm.expect(b.result).to.eql('options'));",
            "pm.test('reason codes', () => pm.expect(b.reasonCodes).to.eql(['BEHIND_SCHEDULE', 'WINDOW_CLOSES_SOON']));",
            "pm.test('opt-1 cab +350', () => { pm.expect(b.options[0].label).to.eql('Take a cab to the bank'); pm.expect(b.options[0].extraFareInr).to.eql(350); });",
            "pm.test('opt-2 keeps it cheap', () => { pm.expect(b.options[1].extraFareInr).to.eql(0); pm.expect(b.options[1].movedTasks).to.eql(['task-office']); });",
        ],
        example={
            "planId": "plan-001",
            "result": "options",
            "reasonCodes": ["BEHIND_SCHEDULE", "WINDOW_CLOSES_SOON"],
            "options": [
                {"optionId": "opt-1", "label": "Take a cab to the bank", "extraFareInr": 350, "movedTasks": [], "reasonCodes": ["FASTER_MODE", "RAASTA_VERIFIED"]},
                {"optionId": "opt-2", "label": "Keep it cheap", "extraFareInr": 0, "movedTasks": ["task-office"], "reasonCodes": ["TASK_MOVED_TOMORROW"]},
            ],
        },
    ),
    req(
        "Repeat the same check-in (idempotent)",
        "POST",
        "/v1/trips/trip-001/checkins",
        data={"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": "{{checkinKey}}"},
        tests=["pm.test('replayed', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true'));"],
    ),
    req(
        "Accept opt-1",
        "POST",
        "/v1/trips/trip-001/options/opt-1/accept",
        data={"idempotencyKey": KEY},
        tests=["const p = pm.response.json(); pm.test('version 2', () => { pm.expect(p.version).to.eql(2); pm.expect(p.trigger).to.eql('late'); });"],
        example={"planId": "plan-002", "version": 2, "status": "active", "trigger": "late", "ruleVersion": "1.0", "legs": [{"seq": 1, "taskId": "task-bank", "mode": "cab", "leaveBy": "2026-10-14T11:45:00+05:30", "arriveAt": "2026-10-14T12:35:00+05:30", "travelMin": 50, "fareInr": 430}], "reasonCodes": ["FASTER_MODE"], "explanation": "A cab keeps all three tasks today for ₹350 more."},
    ),
    req(
        "Day summary",
        "GET",
        "/v1/trips/trip-001/summary",
        tests=["const s = pm.response.json(); pm.test('₹560, 2 h 50 min', () => { pm.expect(s.totals.fareInr).to.eql(560); pm.expect(s.totals.travelMin).to.eql(170); });"],
        example={"headline": "0 of 3 tasks done. Rerouted once, at 10:55.", "totals": {"travelMin": 170, "fareInr": 560, "waitMin": 0}},
    ),
    req("Trip with active plan and log", "GET", "/v1/trips/trip-001", tests=["pm.test('v2 active', () => pm.expect(pm.response.json().activePlan.version).to.eql(2));"]),
    req("Undo: make version 1 active", "POST", "/v1/trips/trip-001/plans/1/activate", data={"idempotencyKey": KEY}, tests=["pm.test('v1 back', () => pm.expect(pm.response.json().version).to.eql(1));"]),
    req(
        "Create a share link",
        "POST",
        "/v1/trips/trip-001/share-links",
        data={"idempotencyKey": KEY},
        status=201,
        tests=["const b = pm.response.json(); pm.collectionVariables.set('shareToken', b.token); pm.collectionVariables.set('shareId', b.shareId);"],
        example={"shareId": "shr-…", "tripId": "trip-001", "token": "Xk…", "url": "https://localhost/shared/Xk…", "expiresAt": "2026-10-15T23:59:00+05:30"},
    ),
    req("Family view", "GET", "/v1/shared/{{shareToken}}", auth=False, tests=["pm.test('no coordinates', () => pm.expect(pm.response.text()).to.not.include('lng'));"], example={"travellerFirstName": "Arjun", "cityName": "Bengaluru", "stops": []}),
    req("Family can't change anything", "POST", "/v1/trips/trip-001/checkins", data={"taskId": "task-meet", "kind": "done", "idempotencyKey": KEY}, auth=False, status=401),
    req("Revoke the share link", "DELETE", "/v1/share-links/{{shareId}}", status=204),
    req("Revoked link is gone", "GET", "/v1/shared/{{shareToken}}", auth=False, status=410, example={"error": {"code": "GONE", "message": "This trip is no longer shared.", "traceId": "…"}}),
    req("Errors share one shape", "GET", "/v1/trips/no-such-trip", status=404, tests=["pm.test('shape', () => pm.expect(pm.response.json().error).to.have.keys('code', 'message', 'traceId'));"]),
]

raasta = [
    req("Route options for a leg", "GET", "/v1/raasta/routes?from=77.6195,12.9352&to=77.5838,12.9255&at=2026-10-14T15:00:00%2B05:30", auth=False, tests=["pm.test('kor-jay', () => pm.expect(pm.response.json().items.map(r => r.routeId)).to.include('sample-kor-jay'));"]),
    req("Route after its last trip", "GET", "/v1/raasta/routes?from=77.6195,12.9352&to=77.5838,12.9255&at=2026-10-14T22:30:00%2B05:30", auth=False, tests=["pm.test('left out', () => pm.expect(pm.response.json().lastTripPassed).to.include('sample-kor-jay'));"]),
    req("One route", "GET", "/v1/raasta/routes/sample-kor-jay", auth=False, tests=["const r = pm.response.json(); pm.test('verified ₹30', () => { pm.expect(r.status).to.eql('verified'); pm.expect(r.fareInr).to.eql(30); });"]),
    req("Stands near the bank", "GET", "/v1/raasta/stands?near=77.6195,12.9352&radius=800", auth=False),
    req("GTFS export", "GET", "/v1/raasta/cities/bengaluru/gtfs.zip", auth=False, tests=["pm.test('zip', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('zip'));"]),
    req("Moderator sign-in", "POST", "/v1/auth/demo", data={"as": "moderator"}, auth=False, tests=["pm.collectionVariables.set('accessToken', pm.response.json().accessToken);"]),
    req("Moderator queue", "GET", "/v1/raasta/contributions?status=waiting"),
    req("Fare reports waiting", "GET", "/v1/raasta/fare-reports?status=waiting"),
]

collection = {
    "info": {
        "name": "Reroute and Raasta APIs",
        "description": "Replays the Bengaluru demo day (sample data). Run against `docker compose up` with DEMO_LOGIN=true. Times and fares are estimates.",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "variable": [{"key": "baseUrl", "value": "https://localhost"}, {"key": "accessToken", "value": ""}],
    "item": [{"name": "Reroute", "item": reroute}, {"name": "Raasta", "item": raasta}],
}

(HERE / "reroute.postman_collection.json").write_text(json.dumps(collection, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Wrote {sum(len(g['item']) for g in collection['item'])} requests")
