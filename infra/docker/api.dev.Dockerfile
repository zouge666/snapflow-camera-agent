FROM python:3.13.14-slim-bookworm@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /workspace

COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/api/src apps/api/src

RUN python -m pip install --editable ./apps/api

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "snapflow.main:create_app", "--factory", "--reload", "--reload-dir", "/workspace/apps/api/src", "--host", "0.0.0.0", "--port", "8000"]
