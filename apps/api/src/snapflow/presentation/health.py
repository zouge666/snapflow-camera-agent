"""Process liveness endpoint."""

from typing import Literal, TypedDict

from fastapi import APIRouter

router = APIRouter(tags=["health"])


class LiveHealth(TypedDict):
    service: Literal["api"]
    status: Literal["ok"]


@router.get("/health/live", response_model=LiveHealth)
async def get_liveness() -> LiveHealth:
    """Report process liveness without calling external dependencies."""
    return {"service": "api", "status": "ok"}
