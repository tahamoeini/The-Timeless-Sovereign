"""Domain errors exposed by the command boundary."""


class LKEError(Exception):
    """Base class for expected application errors."""


class ValidationError(LKEError):
    """A command is malformed or violates a domain invariant."""


class NotFoundError(LKEError):
    """A workspace, branch, or record does not exist in the requested scope."""


class ConflictError(LKEError):
    """A command was prepared against a stale revision or duplicate identity."""


class IdempotencyConflictError(LKEError):
    """An idempotency key was reused for a different command."""
