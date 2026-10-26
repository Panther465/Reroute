"""Writes the Azure server's settings (the production .env deploy.sh sends it), once.

It keeps the keys Reroute uses from the .env at the repository root (Gemini, Google sign-in and Maps, Azure Speech,
RICO_KEY) and makes new random passwords and secrets for the server, never the local ones. An existing file is left
as it is, so the server's database passwords never change under it. Nothing secret is printed.

    python infra/azure/make_env.py D:/reroute-secrets/azure.env https://reroute-app.centralindia.cloudapp.azure.com
"""

import secrets
import sys
from pathlib import Path

KEEP = [
    "GEMINI_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_MAPS_API_KEY",
    "GOOGLE_MAPS_BROWSER_KEY",
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "RICO_KEY",
]


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip()
    return values


def main() -> None:
    target, public_url = Path(sys.argv[1]), sys.argv[2].rstrip("/")
    if target.exists():
        print(f"{target} already exists: left as it is.")
        return
    local = read_env(Path(__file__).resolve().parents[2] / ".env")
    lines = [
        "# Reroute's Azure server (infra/azure/README.md). Made by make_env.py; never commit it.",
        f"PUBLIC_BASE_URL={public_url}",
        "BIND_ADDR=0.0.0.0",
        "AI_HELPER_ENABLED=true",
        "FCM_SERVICE_ACCOUNT=/opt/reroute/secrets/fcm-service-account.json",
        f"JWT_SECRET={secrets.token_urlsafe(48)}",
        f"RAASTA_SERVICE_TOKEN={secrets.token_urlsafe(48)}",
        f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}",
        f"REROUTE_DB_PASSWORD={secrets.token_urlsafe(32)}",
        f"RAASTA_DB_PASSWORD={secrets.token_urlsafe(32)}",
    ]
    kept = [name for name in KEEP if local.get(name)]
    lines += [f"{name}={local[name]}" for name in kept]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {target}: new server secrets, and {', '.join(kept) or 'no keys'} from the local .env.")


if __name__ == "__main__":
    main()
