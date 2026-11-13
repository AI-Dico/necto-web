# Web — a Necto desktop plugin for browser pages

Inspects pages in Chrome, Anchae or Electron from inside [Necto](https://github.com/toss/necto),
next to the iOS and Android apps Necto already debugs. It speaks the Chrome DevTools
Protocol (CDP) directly from the panel.

- **Network** — every request with status, method, type, start time, duration and size;
  request and response headers, request body, response body on demand, and a cURL copy.
  Redirect hops and failed loads (DNS, canceled) get rows of their own.
- **Console** — `console.*` calls with object previews, uncaught exceptions and the
  browser's own log entries, with level and `file:line`.

It is a desktop plugin: it works without a connected app and binds only
`necto.desktop.*` operations. Nothing in Necto itself changes.

## Using it

1. Start the browser with a DevTools port that accepts the panel's origin:

   ```bash
   open -na "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins='*' \
     --user-data-dir="$HOME/.chrome-necto"
   ```

   Anchae listens on 9339.
2. In Necto open **Web**, enter the port and press **Find tabs**. The first time, Necto asks
   to approve one command (below).
3. Pick a tab and **Connect**. Requests made after connecting appear; **Reload page** to
   see a page load from the start.

### Why a shell command

The panel cannot read `http://localhost:<port>/json/list` itself: Chrome sends no CORS
header, so the WebView refuses the response. The plugin asks Necto to approve exactly
one command, which reads the port from standard input and refuses anything but digits:

```bash
read -r p; case "$p" in ""|*[!0-9]*) echo "bad port" >&2; exit 2;; esac; curl -sS --max-time 3 "http://localhost:$p/json/list"
```

One approval covers every port, and nothing the panel sends reaches the shell as code.

### Measured constraints (Chrome 157, Necto 0.3.0)

- The DevTools socket opens only as `ws://localhost:…`; `ws://127.0.0.1:…` from the panel
  closes with 1006. Target URLs are rewritten to `localhost`.
- Without `--remote-allow-origins` Chrome refuses the panel's origin
  (`necto-plugin://<id>`).

## Developing

```bash
npm install
npm test        # tsc + node:test for the CDP modules (Node 22.18+)
npm run build   # dist/
necto install dist --local --json
```

`src/cdp/` holds the protocol code with no Necto or DOM dependency: `targets.ts`
(discovery), `network.ts` (Network events → records), `console.ts` (console entries),
`client.ts` (the socket). `src/main.ts` is the panel.
