"""Minimal ArcGIS REST client: POSTed queries with retries (no third-party HTTP library)."""

from __future__ import annotations

import gzip
import http.client
import json
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # system Pythons usually have a CA bundle already
        return ssl.create_default_context()


SSL_CONTEXT = _ssl_context()
USER_AGENT = "pa2-pipeline/0.1"


class ServiceError(RuntimeError):
    """The service answered with an {"error": ...} body."""


class QueryFailed(RuntimeError):
    """Every retry of one request failed."""


def describe(exc: BaseException | None) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code} {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return f"network error: {exc.reason}"
    return f"{type(exc).__name__}: {exc}"[:200]


def query(url: str, params: dict, *, attempts: int = 7, label: str = "", timeout: int = 180) -> dict:
    """POST `params` to a FeatureServer/MapServer `.../query` URL; retry transient failures with backoff."""
    body = urllib.parse.urlencode(params).encode()
    last: BaseException | None = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(min(2**attempt, 45) + random.random())
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "User-Agent": USER_AGENT,
                "Accept-Encoding": "gzip",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
                raw = resp.read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            data = json.loads(raw)
            if isinstance(data, dict) and "error" in data:
                raise ServiceError(json.dumps(data["error"])[:300])
            return data
        # OSError covers URLError/HTTPError, timeouts, resets and SSL errors; ValueError covers bad JSON;
        # HTTPException covers truncated bodies (IncompleteRead); EOFError a truncated gzip stream.
        except (OSError, EOFError, ValueError, http.client.HTTPException, ServiceError) as exc:
            last = exc
            if label:
                print(f"    {label}: {describe(exc)} (attempt {attempt + 1}/{attempts})", file=sys.stderr, flush=True)
    raise QueryFailed(f"query failed after {attempts} attempts: {describe(last)}")
