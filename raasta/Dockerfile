# Raasta API
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/raasta

RUN groupadd --system raasta && useradd --system --gid raasta --home /srv/raasta raasta

# pip downloads with the classic key exchange: OpenSSL 3.5's larger post-quantum handshake fills a full-size packet,
# and some networks silently drop those on the way to PyPI (Azure Central India, November 2026).
RUN printf '%s\n' 'openssl_conf = pip_conf' '[pip_conf]' 'ssl_conf = pip_ssl' '[pip_ssl]' 'system_default = pip_tls' '[pip_tls]' \
    'Groups = X25519:prime256v1' > /etc/ssl/pip-openssl.cnf
COPY pyproject.toml ./
RUN export OPENSSL_CONF=/etc/ssl/pip-openssl.cnf && pip install --upgrade pip && pip install "fastapi>=0.115,<1" "uvicorn[standard]>=0.32" "pydantic>=2.9,<3" "pydantic-settings>=2.6" \
    "sqlalchemy>=2.0.36" "psycopg[binary]>=3.2" "alembic>=1.14" "geoalchemy2>=0.16" "redis>=5.2,<8.2" "pymongo>=4.10" "httpx>=0.28" "pyjwt[crypto]>=2.10"

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R raasta:raasta /srv/raasta

USER raasta
EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/v1/raasta/healthz', timeout=2).status == 200 else 1)"

ENTRYPOINT ["./docker-entrypoint.sh"]
# The API writes its own access log without query strings (they carry coordinates), so uvicorn's is off.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]
