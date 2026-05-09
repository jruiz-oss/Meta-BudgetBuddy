"""
Token-at-rest encryption.

Wraps cryptography.fernet so the User.global_meta_token / Account.meta_token
columns can be transparently encrypted via the EncryptedString TypeDecorator
in database.py. A Neon snapshot or accidental log dump no longer hands an
attacker working Meta tokens.

Env var:
    TOKEN_ENCRYPTION_KEY   url-safe base64 32-byte Fernet key (REQUIRED in prod).
                           Generate one with:
                               python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Backwards compat:
    Existing rows (written before this module landed) are plaintext. We tag every
    new ciphertext with the prefix "enc_v1:" so reads can tell the two apart:
      - prefixed value  → decrypt with Fernet
      - bare value      → return as-is (legacy plaintext); will be re-encrypted
                          the next time the row is written
    No DB migration is required, just deploy with the env var set.

Key rotation:
    To rotate, generate a new key, set TOKEN_ENCRYPTION_KEY_OLD to the old one,
    and on next read of an old-key row we'll fall through to the old key, decrypt,
    and the next write will re-encrypt under the new key. (Not implemented yet —
    add when first rotation is needed.)
"""

import logging
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_ENC_PREFIX = "enc_v1:"

# Dev-only fallback so local-dev databases survive across restarts without
# requiring a key in .env. This key is intentionally well-known — it must not
# be used in production. Production refuses to boot if TOKEN_ENCRYPTION_KEY
# is unset (see _get_fernet below).
_DEV_FALLBACK_KEY = b"k8mZ7XzFq2N3vR9pL5tH1wJ4cY6sD0aB8eU3iO7gM2k="

_fernet: Optional[Fernet] = None


def _get_fernet() -> Fernet:
    """Lazily build the Fernet instance from TOKEN_ENCRYPTION_KEY.

    Lazy so importing this module doesn't fail when the env var isn't set
    (e.g. during static analysis, ast.parse, etc.). The Flask app boot path
    will hit it on the first read/write of an encrypted column.
    """
    global _fernet
    if _fernet is not None:
        return _fernet

    key = os.getenv("TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        if os.getenv("FLASK_ENV") == "production":
            raise RuntimeError(
                "TOKEN_ENCRYPTION_KEY env var must be set in production. "
                "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )
        logger.warning(
            "TOKEN_ENCRYPTION_KEY not set — using a dev-only fallback key. "
            "Tokens encrypted with this key are NOT secure. Set the env var before deploying."
        )
        _fernet = Fernet(_DEV_FALLBACK_KEY)
        return _fernet

    if isinstance(key, str):
        key_b = key.encode()
    else:
        key_b = key
    try:
        _fernet = Fernet(key_b)
    except Exception as e:
        raise RuntimeError(
            f"TOKEN_ENCRYPTION_KEY is not a valid Fernet key ({e}). "
            "Regenerate with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return _fernet


def encrypt_token(plaintext: Optional[str]) -> Optional[str]:
    """Encrypt a token for storage. Returns the value unchanged when empty/None.

    Idempotent: passing already-encrypted ciphertext returns it as-is so a
    round-trip read→write doesn't double-encrypt.
    """
    if plaintext is None or plaintext == "":
        return plaintext
    if plaintext.startswith(_ENC_PREFIX):
        return plaintext
    f = _get_fernet()
    return _ENC_PREFIX + f.encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_token(value: Optional[str]) -> Optional[str]:
    """Decrypt a stored token. Legacy plaintext (no prefix) is returned as-is.

    A failed decrypt (wrong key, corrupted ciphertext) is logged and returns
    an empty string rather than raising — the caller (e.g. effective_meta_token)
    will then surface a "no Meta token configured" error to the UI instead of
    a 500.
    """
    if value is None or value == "":
        return value
    if not value.startswith(_ENC_PREFIX):
        return value  # legacy plaintext — re-encrypted on next write
    f = _get_fernet()
    payload = value[len(_ENC_PREFIX):]
    try:
        return f.decrypt(payload.encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.error(
            "Token decryption failed — wrong TOKEN_ENCRYPTION_KEY, or row was "
            "encrypted under a different key. Returning empty so the caller "
            "surfaces a clean error."
        )
        return ""
