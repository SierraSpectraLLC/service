# Vendored from MeshCentral

These two files are taken from **MeshCentral 1.2.4**, © Intel Corporation and
contributors, licensed under the Apache License 2.0 — full text in `LICENSE`
beside them.

| File | Origin in the package | What it does |
| --- | --- | --- |
| `agent-desktop-0.0.2.js` | `public/scripts/` | Decodes the agent's desktop stream onto a canvas and encodes mouse and keyboard back |
| `agent-redir-ws-0.1.1.js` | `public/scripts/` | Carries that stream over a WebSocket to the relay host |

They are here rather than loaded from the relay host so a remote session renders
inside the portal, on our own page, instead of in the engine's console.

## Modifications

Apache-2.0 asks that changes be stated. There is one, marked in the file with a
`SIERRA MODIFICATION` comment:

- **`agent-redir-ws-0.1.1.js`, `obj.Start`** — the relay socket address was
  derived from `window.location`, which is correct when the page is served by the
  relay host and wrong when it is served by the portal. It now uses
  `obj.relayBase` when that is set, and falls back to the original behavior when
  it is not.

Nothing else is altered. The decoder is untouched.

## Upgrading

These files are pinned to the same engine build as everything else in
`src/lib/remote.ts`. When the host is upgraded:

1. Diff the new `public/scripts/agent-desktop-*.js` and `agent-redir-ws-*.js`
   against these copies.
2. Re-apply the one modification above.
3. Re-run the seven-step gate in `docs/REMOTE_HOST_SETUP.md`. A desktop that
   paints but takes no input is the failure to watch for, and no test here can
   catch it — it needs a real machine.

Leaving these stale is safer than leaving the server stale, but not indefinitely:
they carry the wire format for the desktop stream, and the agent is updated by the
server.
