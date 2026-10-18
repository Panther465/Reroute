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
COPY backend/pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt

COPY backend/ ./
COPY examples/ /srv/examples/
RUN chmod +x docker-entrypoint.sh

USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/v1/healthz', timeout=2).status == 200 else 1)" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["api"]
