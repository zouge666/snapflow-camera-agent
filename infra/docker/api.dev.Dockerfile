FROM python:3.13.11-slim-bookworm@sha256:97e9392d12279f8c180eb80f0c7c0f3dfe5650f0f2573f7ad770aea58f75ed12

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /workspace

COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/api/constraints.txt apps/api/constraints.txt
COPY apps/api/alembic.ini apps/api/alembic.ini
COPY apps/api/migrations apps/api/migrations
COPY apps/api/src apps/api/src

RUN python -m pip install --constraint ./apps/api/constraints.txt --editable ./apps/api

EXPOSE 8000

CMD ["sh", "-c", "python -m alembic -c apps/api/alembic.ini upgrade head && python -m uvicorn snapflow.main:create_app --factory --reload --reload-dir /workspace/apps/api/src --host 0.0.0.0 --port 8000"]
