"""Use cases for guest credentials and idempotent run creation."""

from dataclasses import dataclass
from datetime import datetime

from snapflow.domain.run_contract import CreateRunRequest, GuestSessionResponse
from snapflow.persistence.guest_runs import CreatedRun, GuestRunRepository
from snapflow.security.guest_tokens import GuestPrincipal, GuestTokenService


@dataclass(frozen=True, slots=True)
class GuestRunService:
    """Coordinate token verification with persistent owner and run state."""

    repository: GuestRunRepository
    tokens: GuestTokenService

    def create_session(self) -> GuestSessionResponse:
        """Create a persistent guest and issue its first access token."""
        session = self.repository.create_guest_session()
        token, principal = self.tokens.issue(session.id, session.expires_at)
        return self._session_response(token, principal, session.expires_at)

    def refresh_session(self, bearer_token: str) -> GuestSessionResponse:
        """Rotate a valid access token while the guest owner is still live."""
        principal = self.tokens.verify(bearer_token)
        session = self.repository.require_guest_session(principal.session_id)
        token, refreshed = self.tokens.issue(session.id, session.expires_at)
        return self._session_response(token, refreshed, session.expires_at)

    def create_run(
        self,
        bearer_token: str,
        idempotency_key: str,
        request: CreateRunRequest,
    ) -> CreatedRun:
        """Authenticate the guest and persist one idempotent run."""
        principal = self.tokens.verify(bearer_token)
        return self.repository.create_run(
            principal.session_id,
            idempotency_key,
            request,
        )

    @staticmethod
    def _session_response(
        token: str,
        principal: GuestPrincipal,
        session_expires_at: datetime,
    ) -> GuestSessionResponse:
        return GuestSessionResponse(
            schema_version="1.0",
            guest_session_id=principal.session_id,
            access_token=token,
            token_type="Bearer",
            expires_at=principal.expires_at,
            session_expires_at=session_expires_at,
        )
