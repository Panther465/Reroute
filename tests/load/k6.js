// Load test (definition of done, item 12): 500 virtual users, 95% of responses under 500 ms.
//
// Every virtual user shares the demo traveller, so raise the per-user rate limit for the run:
//   RATE_LIMIT_PER_MINUTE=1000000 docker compose up -d --build
//   k6 run -e BASE_URL=https://localhost --insecure-skip-tls-verify tests/load/k6.js
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "https://localhost";

export const options = {
  scenarios: {
    travellers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 500 },
        { duration: "2m", target: 500 },
        { duration: "20s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  const res = http.post(`${BASE}/v1/auth/demo`, JSON.stringify({ as: "traveller" }), { headers: { "Content-Type": "application/json" } });
  check(res, { "signed in": (r) => r.status === 200 });
  const token = res.json("accessToken");
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  // Make sure the demo day has a plan, so reads return a full timeline.
  const trip = http.get(`${BASE}/v1/trips/trip-001`, auth).json();
  if (!trip.activePlan) {
    http.post(`${BASE}/v1/trips/trip-001/plans`, JSON.stringify({ idempotencyKey: `load-plan-${Date.now()}` }), { headers: { ...auth.headers, "Content-Type": "application/json" } });
    sleep(2);
  }
  return { token };
}

export default function (data) {
  const auth = { headers: { Authorization: `Bearer ${data.token}` } };
  const trip = http.get(`${BASE}/v1/trips/trip-001`, { ...auth, tags: { name: "GET trip" } });
  check(trip, { "trip 200": (r) => r.status === 200 });

  const routes = http.get(`${BASE}/v1/raasta/routes?from=77.6195,12.9352&to=77.5838,12.9255&at=2026-10-14T15:00:00%2B05:30`, { tags: { name: "GET raasta routes" } });
  check(routes, { "routes 200": (r) => r.status === 200 });

  const summary = http.get(`${BASE}/v1/trips/trip-001/summary`, { ...auth, tags: { name: "GET summary" } });
  check(summary, { "summary 200": (r) => r.status === 200 });

  sleep(1);
}
