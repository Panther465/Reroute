-- Runs once, when the database volume is first created.
-- Two application roles keep the module boundary at the database level:
-- reroute_app owns the public schema and has no access to the raasta schema;
-- raasta_app owns the raasta schema only. Reroute reaches Raasta over HTTP, never through tables.

CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reroute_app') THEN
    CREATE ROLE reroute_app LOGIN PASSWORD 'reroute_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raasta_app') THEN
    CREATE ROLE raasta_app LOGIN PASSWORD 'raasta_app';
  END IF;
END
$$;

-- Passwords above are for local development only; deployments set their own through
-- REROUTE_DB_PASSWORD and RAASTA_DB_PASSWORD (see infra/postgres/set-passwords.sh).

GRANT CONNECT ON DATABASE reroute TO reroute_app, raasta_app;

ALTER SCHEMA public OWNER TO reroute_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO raasta_app; -- PostGIS types and functions live in public

CREATE SCHEMA IF NOT EXISTS raasta AUTHORIZATION raasta_app;
REVOKE ALL ON SCHEMA raasta FROM PUBLIC;
REVOKE ALL ON SCHEMA raasta FROM reroute_app;
