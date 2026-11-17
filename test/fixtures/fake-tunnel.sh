#!/bin/sh
# The fake canvas-tunnel helper for tests (fake-tunnel.ts). Node comes from CANVAS_FAKE_TUNNEL_NODE.
exec "$CANVAS_FAKE_TUNNEL_NODE" "$(dirname "$0")/fake-tunnel.ts"
