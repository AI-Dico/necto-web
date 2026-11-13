//
// Copyright (c) 2026 AI-Dico
//

/// One page a DevTools endpoint offers, as `/json/list` describes it.
export interface DevToolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/// The one command a user approves. The port arrives on standard input rather than in
/// the string, so a single approval covers Chrome on 9222, an Electron app on its own port and
/// anything else, and nothing the panel types can reach the shell as code.
export const DISCOVERY_COMMAND =
  'read -r p; case "$p" in ""|*[!0-9]*) echo "bad port" >&2; exit 2;; esac; ' +
  'curl -sS --max-time 3 "http://localhost:$p/json/list"';

const INSPECTABLE = new Set(["page", "webview", "iframe", "other"]);

/// Chrome accepts the DevTools socket from a Necto panel only through `localhost`:
/// measured on Chrome 157, `ws://127.0.0.1:…` from the panel closes with 1006 while
/// `ws://localhost:…` to the same target opens.
export function panelSocketURL(url: string): string {
  return url.replace(/^ws:\/\/(127\.0\.0\.1|\[::1\])(?=[:/])/, "ws://localhost");
}

export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{2,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/// Pages first, then everything else, each group in the order the browser listed it.
/// Targets that cannot be attached (no socket URL, or one already taken by another
/// DevTools client) are left out.
export function parseTargets(stdout: string): DevToolsTarget[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("The endpoint did not return a target list.");

  const targets: DevToolsTarget[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const socket = entry.webSocketDebuggerUrl;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (typeof socket !== "string" || !socket || !INSPECTABLE.has(type)) continue;

    targets.push({
      id: String(entry.id ?? socket),
      type,
      title: typeof entry.title === "string" ? entry.title : "",
      url: typeof entry.url === "string" ? entry.url : "",
      webSocketDebuggerUrl: panelSocketURL(socket),
    });
  }

  return [
    ...targets.filter((target) => target.type === "page"),
    ...targets.filter((target) => target.type !== "page"),
  ];
}
