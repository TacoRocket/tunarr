"""Named, read-only HTTP requests to an extension's configured service."""

import errno
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import subprocess
import sys
from urllib.parse import urlencode, urlsplit


MAX_RESPONSE = 4 * 1024 * 1024
READ_TIMEOUT = 8
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
PATH_SEGMENT = re.compile(r"[A-Za-z0-9._~-]+")
CREDENTIAL_HEADERS = {"authorization", "x-api-key", "api-key"}
# Some providers also expose instance metadata on non-link-local addresses.
METADATA_ADDRESSES = {ipaddress.ip_address(value) for value in (
    "100.100.100.200", "168.63.129.16", "fd00:ec2::254", "fd00:ec2::23",
)}
TRANSLATION_PREFIXES = tuple(ipaddress.ip_network(value) for value in (
    "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16",
))


class BrokerError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _fixed_path(value):
    return isinstance(value, str) and 0 < len(value) <= 1024 and all(
        segment not in (".", "..") and PATH_SEGMENT.fullmatch(segment)
        for segment in value.split("/")
    )


def validate_reads(manifest):
    """Validate the complete set of read capabilities before installation."""
    fields = {field["key"]: field["type"] for field in manifest.get("settings", [])}
    reads = manifest.get("reads", [])
    if not isinstance(reads, list) or len(reads) > 32:
        raise BrokerError(422, "Invalid service read declarations.")
    ids = set()
    for read in reads:
        if not isinstance(read, dict) or read.keys() - {"id", "baseUrlSetting", "path", "credential", "query"}:
            raise BrokerError(422, "Invalid service read declaration.")
        identifier = read.get("id")
        base = read.get("baseUrlSetting")
        if (not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier) or identifier in ids
                or not isinstance(base, str) or fields.get(base) != "url" or not _fixed_path(read.get("path"))):
            raise BrokerError(422, "A service read needs a unique ID, a URL setting and a fixed relative path.")
        ids.add(identifier)
        query = read.get("query", [])
        if (not isinstance(query, list) or len(query) > 16
                or any(not isinstance(k, str) or not IDENTIFIER.fullmatch(k) for k in query)
                or len(set(query)) != len(query)):
            raise BrokerError(422, "Invalid service read query keys.")
        if "credential" in read:
            cred = read["credential"]
            if (not isinstance(cred, dict) or cred.keys() != {"setting", "header"}
                    or not isinstance(cred["setting"], str) or fields.get(cred["setting"]) != "secret"
                    or not isinstance(cred["header"], str) or cred["header"].lower() not in CREDENTIAL_HEADERS):
                raise BrokerError(422, "Unsupported service credential header or setting.")


def _request_parts(read, settings, params):
    if not isinstance(params, dict) or params.keys() - set(read.get("query", [])):
        raise BrokerError(400, "The service read received an undeclared query parameter.")
    query = {}
    for key, value in params.items():
        if type(value) not in (str, int, float, bool) or (isinstance(value, float) and not math.isfinite(value)):
            raise BrokerError(400, "Service query parameters must be scalar values.")
        value = str(value).lower() if isinstance(value, bool) else str(value)
        if len(value) > 1024:
            raise BrokerError(400, "A service query parameter is too long.")
        query[key] = value

    raw = settings.get(read["baseUrlSetting"])
    try:
        if not isinstance(raw, str) or len(raw) > 2048 or not raw.isascii() or any(ord(c) <= 32 or ord(c) >= 127 for c in raw):
            raise ValueError
        url = urlsplit(raw)
        host = url.hostname
        port = url.port
        if (url.scheme not in ("http", "https") or not host or not re.fullmatch(r"[A-Za-z0-9:._\-]+", host)
                or url.username is not None or url.password is not None or "?" in raw or "#" in raw or port == 0):
            raise ValueError
        base = url.path.removeprefix("/").removesuffix("/")
        if "//" in url.path or (base and not _fixed_path(base)):
            raise ValueError
    except ValueError:
        raise BrokerError(400, "Enter a valid HTTP or HTTPS service address and optional base path.") from None
    path = "/" + (base + "/" if base else "") + read["path"]
    if query:
        path += "?" + urlencode(query)
    headers = {"Accept": "application/json"}
    if cred := read.get("credential"):
        if secret := settings.get(cred["setting"]):
            if not isinstance(secret, str) or not re.fullmatch(r"[ -~]{1,4096}", secret):
                raise BrokerError(400, "The service credential is not a valid HTTP header value.")
            headers[cred["header"]] = secret
    return {"scheme": url.scheme, "host": host, "port": port, "path": path, "headers": headers}


def _check_address(family, sockaddr):
    ip = ipaddress.ip_address(sockaddr[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if (ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_multicast or ip.is_reserved
            or ip in METADATA_ADDRESSES or any(ip in network for network in TRANSLATION_PREFIXES)
            or (ip.version == 4 and int(ip) < 1 << 24)):
        raise BrokerError(403, "The configured service address is blocked.")
    # A successful bind identifies a local interface, including secondary addresses
    # and Docker network aliases, without relying on the container's hostname.
    with socket.socket(family, socket.SOCK_DGRAM) as probe:
        try:
            probe.bind((sockaddr[0], 0, *sockaddr[2:]))
        except OSError as exc:
            if exc.errno != errno.EADDRNOTAVAIL:
                raise
        else:
            raise BrokerError(403, "The configured service address belongs to this host.")


def _download(request):
    host = request["host"]
    if host.rstrip(".").lower() == "localhost" or host.rstrip(".").lower().endswith(".localhost"):
        raise BrokerError(403, "The configured service address is blocked.")
    tls = request["scheme"] == "https"
    port = request["port"] or (443 if tls else 80)
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    for family, _, _, _, sockaddr in addresses:
        _check_address(family, sockaddr)

    # Connect to the exact address checked above. The original hostname remains
    # the HTTP Host, TLS SNI and certificate identity; no proxy or second lookup.
    for family, socktype, proto, _, sockaddr in addresses:
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(READ_TIMEOUT)
        try:
            sock.connect(sockaddr)
            break
        except OSError:
            sock.close()
    else:
        raise BrokerError(502, "Could not connect to the configured service.")
    connection_type = http.client.HTTPSConnection if tls else http.client.HTTPConnection
    connection = connection_type(host, port, timeout=READ_TIMEOUT)
    try:
        connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host) if tls else sock
        connection.request("GET", request["path"], headers=request["headers"])
        with connection.getresponse() as response:
            if response.status != 200:
                raise BrokerError(502, f"Service returned HTTP {response.status}.")
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise BrokerError(502, "The service response exceeds the size limit.")
            return data
    finally:
        connection.close()
        sock.close()


def service_read(manifest, settings, operation_id, params, *, timeout=READ_TIMEOUT):
    read = next((item for item in manifest.get("reads", []) if item["id"] == operation_id), None)
    if not read:
        raise BrokerError(403, "This extension has no such service read.")
    request = _request_parts(read, settings, params)
    # A process deadline also bounds DNS and slow trickles during HTTP header/body reads.
    try:
        proc = subprocess.run([sys.executable, "-I", __file__], input=json.dumps(request).encode(),
                              capture_output=True, env={}, timeout=min(timeout, READ_TIMEOUT))
    except subprocess.TimeoutExpired:
        raise BrokerError(504, "The configured service timed out.") from None
    if proc.returncode == 42:
        status, msg = json.loads(proc.stderr)
        raise BrokerError(status, msg)
    if proc.returncode:
        raise BrokerError(502, "The service read failed.")
    try:
        result = json.loads(proc.stdout)
        if not isinstance(result, (dict, list)):
            raise ValueError
        return result
    except (ValueError, RecursionError):
        raise BrokerError(502, "The service returned invalid JSON.") from None


if __name__ == "__main__":
    try:
        sys.stdout.buffer.write(_download(json.load(sys.stdin)))
    except (OSError, http.client.HTTPException, BrokerError) as exc:
        error = exc if isinstance(exc, BrokerError) else BrokerError(502, "Could not complete the service request.")
        sys.stderr.write(json.dumps([error.status, str(error)]))
        sys.exit(42)
