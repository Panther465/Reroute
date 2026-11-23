# Reroute API, worker and scheduler share this image; the command decides the role.
# Build from the repository root: docker build -f backend/Dockerfile .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    EXAMPLES_DIR=/srv/examples

WORKDIR /srv/backend
RUN groupadd --system app && useradd --system --gid app --home /srv app

# Dependencies first, so code changes don't reinstall them.
# pip downloads with the classic key exchange: OpenSSL 3.5's larger post-quantum handshake fills a full-size packet,
# and some networks silently drop those on the way to PyPI (Azure Central India, November 2026).
RUN printf '%s\n' 'openssl_conf = pip_conf' '[pip_conf]' 'ssl_conf = pip_ssl' '[pip_ssl]' 'system_default = pip_tls' '[pip_tls]' \
    'Groups = X25519:prime256v1' > /etc/ssl/pip-openssl.cnf
COPY backend/pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" > /tmp/requirements.txt \
 && OPENSSL_CONF=/etc/ssl/pip-openssl.cnf pip install -r /tmp/requirements.txt

COPY backend/ ./
COPY examples/ /srv/examples/
RUN chmod +x docker-entrypoint.sh

USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/v1/healthz', timeout=2).status == 200 else 1)" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["api"]
