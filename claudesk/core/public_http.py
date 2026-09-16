from __future__ import annotations

import ipaddress
import socket
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlparse

import httpx

MAX_REDIRECTS = 5
_BLOCKED_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "host.docker.internal",
}
_BLOCKED_SUFFIXES = (".local", ".internal", ".localhost", ".home.arpa")


def _is_public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return ip.is_global and not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


def validate_public_url(url: str, *, https_only: bool = False) -> str:
    parsed = urlparse(url.strip())
    if https_only and parsed.scheme != "https":
        raise ValueError("Only https:// URLs are allowed for PDF downloads and redirects.")
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http:// and https:// URLs are allowed.")

    hostname = (parsed.hostname or "").rstrip(".").lower()
    if not hostname:
        raise ValueError("URL is missing a hostname.")
    if hostname in _BLOCKED_HOSTS or hostname.endswith(_BLOCKED_SUFFIXES):
        raise ValueError("Local or internal network URLs are not allowed.")

    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        if not _is_public_ip(hostname):
            raise ValueError("Local or private IP URLs are not allowed.")

    try:
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Could not resolve URL hostname to verify public network access.") from exc
    if not infos:
        raise ValueError("URL hostname did not resolve to any IP addresses.")

    for info in infos:
        address = info[4][0].split("%", 1)[0]
        if not _is_public_ip(address):
            raise ValueError("Local or private network URLs are not allowed.")

    return parsed.geturl()


@contextmanager
def stream_public_response(
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20.0,
    https_only: bool = False,
) -> Iterator[httpx.Response]:
    """Stream a public response, validating every destination before dispatch."""
    with httpx.Client(headers=headers, timeout=timeout, follow_redirects=False) as client:
        request = client.build_request("GET", url, params=params)
        redirects = 0
        while True:
            validate_public_url(str(request.url), https_only=https_only)
            response = client.send(request, stream=True, follow_redirects=False)
            try:
                next_request = response.next_request
                if next_request is None:
                    yield response
                    return
                if redirects >= MAX_REDIRECTS:
                    raise httpx.TooManyRedirects(
                        "Too many redirects while fetching a public URL.", request=request,
                    )
            finally:
                response.close()
            redirects += 1
            request = next_request
