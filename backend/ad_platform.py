"""
One place that knows which ad platform a thing belongs to, and hands back a
client for it.

Before this module there was exactly one platform, so every route constructed
MetaClient inline. Adding TikTok by repeating that pattern would have meant an
`if platform == ...` at eight call sites, each free to drift. Instead:

    client = client_for_campaign(campaign)     # don't care which platform
    client = client_for_account(account, TIKTOK)

Both return an object with the same methods (see tiktok_client's DESIGN RULE),
so pacing, spend reads and applies stay platform-blind.

CREDENTIALS, and why TikTok is not symmetrical with Meta
--------------------------------------------------------
Meta's token is a user/system-user token that works across every ad account the
system user can see, so one workspace token covers all clients.

TikTok is different in a way that matters operationally: `TIKTOK_APP_ID` and
`TIKTOK_SECRET` identify the *developer app* and authorise NOTHING on their own.
TikTok has no client-credentials grant. A token only exists after an advertiser
opens an authorisation URL and approves the app, and that token covers only the
advertiser accounts included in that authorisation.

So having the app id and secret in the environment is necessary but not
sufficient. `tiktok_status()` below reports exactly which of the three pieces is
present, so the UI can say "you still need to authorise an advertiser" rather
than failing with an opaque API error.
"""

import logging
import os
from typing import Any, Dict, Optional

from meta_client import MetaClient, MetaAPIError
from tiktok_client import TikTokClient, TikTokAPIError

logger = logging.getLogger(__name__)

PLATFORM_META = "META"
PLATFORM_TIKTOK = "TIKTOK"
SUPPORTED_PLATFORMS = (PLATFORM_META, PLATFORM_TIKTOK)

# Use in `except` clauses that want to catch an API failure from either
# platform: `except AD_API_ERRORS as e:`. Keeps call sites from importing both.
AD_API_ERRORS = (MetaAPIError, TikTokAPIError)

# How the sheet's platform section headers map onto our platform constants.
# The Meta section is found by a row whose column A is exactly "Meta"; TikTok
# likewise. Everything else in sheets.STOP_KEYWORDS still terminates a section
# but has no client behind it, so those rows stay untracked — which is the
# existing behaviour for Reddit, Snapchat and the rest.
SHEET_SECTION_PLATFORMS = {
    "meta": PLATFORM_META,
    "tiktok": PLATFORM_TIKTOK,
    "tik tok": PLATFORM_TIKTOK,
}


class PlatformNotConfigured(Exception):
    """Raised when an account has no usable credentials for a platform.

    Deliberately distinct from the API error types: this is a setup problem the
    user can fix in Settings, not a failure of a remote call, and the UI should
    say so differently.
    """


# Everything that can go wrong when talking to a platform, as a FLAT tuple for
# use in `except AD_ERRORS as e:`. It must stay flat — Python raises TypeError
# on a nested tuple in an except clause, and that failure only surfaces at the
# moment an apply errors, which is the worst possible time to discover it.
AD_ERRORS = AD_API_ERRORS + (PlatformNotConfigured,)


def normalise_platform(value: Optional[str]) -> str:
    """Anything falsy means Meta — every pre-TikTok row in the database."""
    v = (value or "").strip().upper()
    return v if v in SUPPORTED_PLATFORMS else PLATFORM_META


# ----------------------------------------------------------------------
# TikTok app-level credentials (environment, set on Railway)
# ----------------------------------------------------------------------
# TikTok's own docs, portal and SDKs use several names for the same three
# values, so whoever sets them up has a decent chance of picking a different one
# than we expected. Accepting the common aliases is cheaper than a support
# conversation that ends in "rename the variable" — and the failure it prevents
# ("TIKTOK_SECRET must be set" when the secret is plainly sitting right there)
# is maximally confusing. First name present wins.
_TIKTOK_ENV_ALIASES = {
    "app_id": ("TIKTOK_APP_ID", "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_KEY"),
    "secret": ("TIKTOK_SECRET", "TIKTOK_APP_SECRET", "TIKTOK_CLIENT_SECRET"),
    "access_token": ("TIKTOK_ACCESS_TOKEN", "TIKTOK_TOKEN"),
}


def _first_env(names) -> tuple:
    """Return (value, name_it_came_from) for the first of `names` that is set."""
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value, name
    return "", None


def tiktok_app_credentials() -> Dict[str, str]:
    """The three values TikTok needs, read from whichever alias is present.

    `access_token` is optional here: an account-level token takes precedence,
    and the OAuth callback stores a workspace token in the database. The
    environment is the third fallback, for workspaces that would rather paste a
    token than run the flow.
    """
    return {key: _first_env(names)[0] for key, names in _TIKTOK_ENV_ALIASES.items()}


def tiktok_env_sources() -> Dict[str, Any]:
    """Which environment variable each credential was read from.

    Names only, never values — this is for the status endpoint, so that
    "configured" can be verified without anyone pasting a secret into chat.
    """
    return {key: _first_env(names)[1] for key, names in _TIKTOK_ENV_ALIASES.items()}


def tiktok_status() -> Dict[str, Any]:
    """What TikTok setup is present, and what is still missing.

    Returned by GET /api/tiktok/status so the answer to "why isn't TikTok
    working" is one request rather than a log dig.
    """
    creds = tiktok_app_credentials()
    has_app = bool(creds["app_id"] and creds["secret"])
    has_token = bool(creds["access_token"])

    missing = []
    if not creds["app_id"]:
        missing.append(" or ".join(_TIKTOK_ENV_ALIASES["app_id"]))
    if not creds["secret"]:
        missing.append(" or ".join(_TIKTOK_ENV_ALIASES["secret"]))

    if not has_app:
        ready, detail = False, "The developer app credentials are missing from the environment."
    elif not has_token:
        ready, detail = False, (
            "App credentials are present, but no advertiser has authorised the app yet. "
            "An app id and secret alone cannot read or write anything on TikTok — an "
            "advertiser must complete the authorisation flow once, which produces the "
            "access token. Tokens issued this way do not expire."
        )
    else:
        ready, detail = True, "App credentials and an access token are both present."

    return {
        "configured": has_app,
        "has_access_token": has_token,
        "ready": ready,
        "missing_env": missing,
        # Which variable each credential actually came from. Names only.
        "env_sources": tiktok_env_sources(),
        "detail": detail,
    }


# ----------------------------------------------------------------------
# Client construction
# ----------------------------------------------------------------------
def effective_tiktok_token(account) -> str:
    """Account override first, then the workspace-level environment token.

    Mirrors Account.effective_meta_token's precedence so the mental model is the
    same across platforms: the specific beats the general.
    """
    own = (getattr(account, "tiktok_token", "") or "").strip()
    if own:
        return own

    # Workspace token captured by the OAuth callback. Imported lazily: this
    # module is imported by the client layer, and a top-level database import
    # would make it circular.
    try:
        from database import User
        user = getattr(account, "user", None)
        if user is not None:
            tok = (getattr(user, "global_tiktok_token", "") or "").strip()
            if tok:
                return tok
        for u in User.query.all():
            tok = (u.global_tiktok_token or "").strip()
            if tok:
                return tok
    except Exception as e:  # no app context, or column not migrated yet
        logger.debug("TikTok workspace token lookup skipped: %s", e)

    return tiktok_app_credentials()["access_token"]


def client_for_account(account, platform: str = PLATFORM_META):
    """A ready client for this account on this platform.

    Raises PlatformNotConfigured with a message meant for a human when the
    account is missing the ids or credentials that platform needs.
    """
    platform = normalise_platform(platform)

    if platform == PLATFORM_TIKTOK:
        advertiser_id = (getattr(account, "tiktok_advertiser_id", "") or "").strip()
        if not advertiser_id:
            raise PlatformNotConfigured(
                f"{account.account_name} has no TikTok advertiser ID linked. "
                f"Link one in Settings → TikTok."
            )
        token = effective_tiktok_token(account)
        if not token:
            raise PlatformNotConfigured(
                "No TikTok access token available. An advertiser must authorise the "
                "app once before TikTok campaigns can be read or paced."
            )
        return TikTokClient(access_token=token, advertiser_id=advertiser_id)

    token = account.effective_meta_token
    if not token:
        raise PlatformNotConfigured(
            f"No Meta token available for {account.account_name}."
        )
    if not account.meta_account_id:
        raise PlatformNotConfigured(
            f"{account.account_name} has no Meta ad account ID."
        )
    return MetaClient(access_token=token, ad_account_id=account.meta_account_id)


def client_for_campaign(campaign):
    """Client for whichever platform this campaign lives on."""
    return client_for_account(campaign.account, getattr(campaign, "platform", PLATFORM_META))


def platform_label(platform: str) -> str:
    return "TikTok" if normalise_platform(platform) == PLATFORM_TIKTOK else "Meta"


def account_supports(account, platform: str) -> bool:
    """Whether this account is set up for a platform at all.

    Used to skip TikTok work entirely for the many accounts that are Meta-only,
    rather than constructing a client and catching the failure.
    """
    platform = normalise_platform(platform)
    if platform == PLATFORM_TIKTOK:
        return bool((getattr(account, "tiktok_advertiser_id", "") or "").strip()
                    and effective_tiktok_token(account))
    return bool(account.meta_account_id and account.effective_meta_token)
