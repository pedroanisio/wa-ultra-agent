#!/usr/bin/env python3
"""Serve the FrameForge MCP server over streamable HTTP, for the eve agent.

── Why this wrapper exists ─────────────────────────────────────────────────
FrameForge ships an MCP server that speaks stdio: `python -m frameforge_mcp`
calls `create_server().run()`, and FastMCP's default transport is stdio. That
works for a client that can spawn a subprocess — Claude Code does — and is
useless to eve, whose MCP connections take a URL and require Streamable HTTP or
SSE (see eve's docs/connections/mcp.mdx). The two never had a way to meet.

FastMCP already supports the transport; nothing here patches FrameForge. This
only asks for `streamable-http` and binds it somewhere the agent container can
actually reach.

── Why it does NOT bind 0.0.0.0 ────────────────────────────────────────────
FrameForge's own capability report says it plainly:

    "code_execution": {"isolation": "subprocess", "sandboxed": false}

`run_sdk_code` executes Python. A server offering that on every interface is a
remote code execution endpoint for anything that can route to this machine.
The default here is the Docker network gateway, which containers on that
network can reach and the LAN cannot. Override deliberately or not at all.
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default=os.environ.get("FRAMEFORGE_HTTP_HOST", "172.20.0.1"),
        help=(
            "Interface to bind. Defaults to the whatsapp-agent compose gateway, so the "
            "agent container can reach it and the network cannot."
        ),
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("FRAMEFORGE_HTTP_PORT", "8811")))
    parser.add_argument(
        "--path",
        default=os.environ.get("FRAMEFORGE_HTTP_PATH", "/mcp"),
        help="Streamable-HTTP mount path. eve's connection url must match it.",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=None,
        help=(
            "A Host header to accept, repeatable (or FRAMEFORGE_ALLOWED_HOSTS, comma-separated). "
            "Needed when the address callers dial is not the address this binds: inside compose "
            "the bind is 0.0.0.0 and the Host header is the SERVICE NAME, so it must be named "
            "here or every call is refused with 421. Defaults to the bind address."
        ),
    )
    args = parser.parse_args()

    if args.host in {"0.0.0.0", "::"} and os.environ.get("FRAMEFORGE_HTTP_ALLOW_ANY") != "yes":
        print(
            "refusing to bind every interface: this server can execute code "
            "(run_sdk_code, unsandboxed). Set FRAMEFORGE_HTTP_ALLOW_ANY=yes if that is "
            "genuinely what you want.",
            file=sys.stderr,
        )
        return 2

    from frameforge_mcp.server import create_server
    from mcp.server.transport_security import TransportSecuritySettings

    server = create_server()
    server.settings.host = args.host
    server.settings.port = args.port
    server.settings.streamable_http_path = args.path

    # DNS-rebinding protection stays ON; it is simply told which Host headers are
    # legitimate. The SDK defaults to localhost only, so a container connecting to
    # the gateway address is rejected with "421 Invalid Host header" — correct
    # behaviour reported clearly, and the fix is to name the host rather than to
    # switch the check off.
    named = args.allowed_host or [
        host.strip() for host in os.environ.get("FRAMEFORGE_ALLOWED_HOSTS", "").split(",") if host.strip()
    ]
    allowed = named or [
        f"{args.host}:{args.port}",
        args.host,
        f"host.docker.internal:{args.port}",
        "host.docker.internal",
    ]
    # Loopback always: the container healthcheck and a local curl dial 127.0.0.1
    # whatever the service is called from outside.
    allowed += [f"127.0.0.1:{args.port}", "127.0.0.1", f"localhost:{args.port}", "localhost"]
    server.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed,
        allowed_origins=[f"http://{h}" for h in allowed],
    )

    effective = server.settings.transport_security
    print(f"frameforge: allowed_hosts={getattr(effective, 'allowed_hosts', None)}", flush=True)
    print(f"frameforge: streamable-http on http://{args.host}:{args.port}{args.path}", flush=True)
    server.run(transport="streamable-http")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
