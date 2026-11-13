//
// Copyright (c) 2026 AI-Dico
//

import { createDetailPane, necto } from "@necto/bridge";

import "./style.css";

import { CdpSession } from "./cdp/client";
import { consoleEntry, type ConsoleEntry } from "./cdp/console";
import { curlCommand, NetworkLog, type NetworkRecord } from "./cdp/network";
import { parsePort, type DevToolsTarget } from "./cdp/targets";
import { listTargets } from "./discovery";
import { t } from "./localization";

// -- elements ----------------------------------------------------------------

/// Nodes, never markup: URLs, headers, bodies and console text all come from the page
/// under inspection.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience; the panel works without it.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// -- formatting --------------------------------------------------------------

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/// Fixed rather than localised, so the column stays narrow and comparable down a list.
function clock(milliseconds: number): string {
  const date = new Date(milliseconds);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(record: NetworkRecord): string {
  if (record.state === "pending") return "…";
  if (record.durationMilliseconds === undefined) return "";
  const ms = record.durationMilliseconds;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function formatBody(text: string, contentType: string | undefined): string {
  if (!contentType?.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function isFailure(record: NetworkRecord): boolean {
  return record.state === "failed" || (record.statusCode ?? 0) >= 400;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}

function codeBlock(text: string): HTMLElement {
  const button = el("button", { type: "button", class: "necto-code-copy" }, [t("copy")]);
  button.addEventListener("click", () => {
    void copyText(text).then((copied) => {
      button.textContent = copied ? t("copied") : t("failed");
      setTimeout(() => (button.textContent = t("copy")), 1400);
    });
  });
  return el("div", { class: "necto-code-block" }, [el("pre", { class: "necto-code" }, [text]), button]);
}

function statusCell(record: NetworkRecord): HTMLElement {
  if (record.state === "pending") return el("span", { class: "necto-status necto-status-idle" }, ["—"]);
  if (record.state === "failed") return el("span", { class: "necto-status necto-status-danger" }, [t("fail")]);
  const code = record.statusCode ?? 0;
  const tone = code >= 500 ? "danger" : code >= 400 ? "warning" : code >= 300 ? "info" : "ok";
  return el("span", { class: `necto-status necto-status-${tone}` }, [String(code)]);
}

const levelTone: Record<ConsoleEntry["level"], string> = {
  error: "danger",
  warning: "warning",
  info: "info",
  log: "idle",
  debug: "idle",
};

function pairs(rows: [string, string][]): HTMLElement {
  if (!rows.length) return el("p", { class: "necto-caption" }, [t("Nothing recorded.")]);
  return el(
    "dl",
    { class: "necto-pairs" },
    rows.map(([label, value]) => el("div", {}, [el("dt", {}, [label]), el("dd", {}, [value])])),
  );
}

// -- state -------------------------------------------------------------------

type View = "network" | "console";
type DetailTab = "summary" | "request" | "response" | "curl";

const network = new NetworkLog();
const consoleEntries: ConsoleEntry[] = [];
const MAX_CONSOLE = 2000;
let consoleID = 0;

let session: CdpSession | null = null;
let connectedTitle = "";
let targets: DevToolsTarget[] = [];
let view: View = (recall("necto-web.view") as View | null) ?? "network";
let status = t("Not connected");
let networkQuery = "";
let consoleQuery = "";
let selectedID: string | null = null;
let detailTab: DetailTab = "summary";
let responseBody: { text?: string; error?: string; note?: string } | null = null;
const detailPane = createDetailPane("necto-web.detail");

// -- the shell ---------------------------------------------------------------

const portField = el("input", {
  class: "necto-field port-field",
  inputmode: "numeric",
  "aria-label": t("Port"),
  value: recall("necto-web.port") ?? "9222",
}) as HTMLInputElement;
const findButton = el("button", { type: "button", class: "necto-button" }, [t("Find tabs")]);
const targetPicker = el("select", { class: "necto-field target-picker", "aria-label": t("Choose a tab") });
const connectButton = el("button", { type: "button", class: "necto-button" }, [t("Connect")]);
const reloadButton = el("button", { type: "button", class: "necto-button necto-button-quiet" }, [
  t("Reload page"),
]);
const statusLine = el("span", { class: "necto-caption status-line" });

const viewTabs = el("div", { class: "necto-tabs view-tabs" });
const filterField = el("input", { class: "necto-field", type: "search" }) as HTMLInputElement;
const count = el("span", { class: "count" });
const clearButton = el(
  "button",
  { type: "button", class: "necto-button necto-button-quiet necto-button-danger" },
  [t("Clear")],
);
const listPane = el("div", { class: "necto-body", tabindex: "0" });
const detailSlot = el("div", { class: "detail-slot" });

/// The connection bar and the view tabs sit outside `.necto-app`: the detail pane turns
/// the nearest `.necto-app` into a grid of one toolbar row over the list, and any extra
/// row there pushes the pane out of place.
document.getElementById("root")?.append(
  el("div", { class: "web-shell" }, [
    el("div", { class: "necto-toolbar" }, [
      el("span", { class: "necto-caption" }, [t("Port")]),
      portField,
      findButton,
      targetPicker,
      connectButton,
      reloadButton,
      statusLine,
    ]),
    viewTabs,
    el("div", { class: "necto-app" }, [
      el("div", { class: "necto-toolbar" }, [filterField, count, clearButton]),
      listPane,
      detailSlot,
    ]),
  ]),
);

// -- rendering ---------------------------------------------------------------

function renderToolbar(): void {
  statusLine.textContent = status;
  const live = session !== null || opening !== null;
  connectButton.textContent = live ? t("Disconnect") : t("Connect");
  connectButton.toggleAttribute("disabled", !live && !targets.length);
  reloadButton.toggleAttribute("disabled", !session);

  targetPicker.replaceChildren(
    ...targets.map((target) =>
      el("option", { value: target.id }, [`${target.title || target.url} — ${target.url}`]),
    ),
  );
  const last = recall("necto-web.target");
  if (last && targets.some((target) => target.id === last)) targetPicker.value = last;
  targetPicker.toggleAttribute("disabled", !targets.length || live);

  viewTabs.replaceChildren(
    ...(["network", "console"] as const).map((id) => {
      const button = el(
        "button",
        { type: "button", class: "necto-tab", "aria-selected": view === id ? "true" : "false" },
        [id === "network" ? t("Network") : t("Console")],
      );
      button.addEventListener("click", () => {
        view = id;
        remember("necto-web.view", id);
        closeDetail();
        renderAll();
      });
      return button;
    }),
  );

  filterField.placeholder = view === "network" ? t("Filter by method, host or path") : t("Filter messages");
  filterField.value = view === "network" ? networkQuery : consoleQuery;
}

function empty(title: string, caption: string): HTMLElement {
  return el("div", { class: "necto-empty" }, [
    el("p", { class: "necto-empty-title" }, [title]),
    el("p", { class: "necto-caption" }, [caption]),
  ]);
}

function visibleRecords(): NetworkRecord[] {
  const term = networkQuery.trim().toLowerCase();
  return [...network.records.values()]
    .filter((record) => !term || `${record.method} ${record.url}`.toLowerCase().includes(term))
    .sort((first, second) => second.startedAtMilliseconds - first.startedAtMilliseconds);
}

function visibleEntries(): ConsoleEntry[] {
  const term = consoleQuery.trim().toLowerCase();
  return consoleEntries
    .filter((entry) => !term || `${entry.level} ${entry.text} ${entry.location ?? ""}`.toLowerCase().includes(term))
    .slice()
    .reverse();
}

function renderList(): void {
  listPane.replaceChildren();

  if (!session && !network.records.size && !consoleEntries.length) {
    count.textContent = "";
    listPane.append(
      empty(
        t("Connect to a browser tab"),
        t("Start Chrome or an Electron app with --remote-debugging-port=9222 --remote-allow-origins='*', then find its tabs."),
      ),
    );
    return;
  }

  if (view === "network") renderNetwork();
  else renderConsole();
}

function renderNetwork(): void {
  const visible = visibleRecords();
  count.textContent = visible.length ? String(visible.length) : "";
  if (!visible.length) {
    listPane.append(
      empty(t("No requests yet"), t("Requests made after connecting appear here. Reload the page to see it load.")),
    );
    return;
  }

  const head = el("tr", {}, [
    el("th", { class: "col-status" }, [t("Status")]),
    el("th", { class: "col-method" }, [t("Method")]),
    el("th", {}, ["URL"]),
    el("th", { class: "col-type" }, [t("Type")]),
    el("th", { class: "col-started necto-numeric" }, [t("Started")]),
    el("th", { class: "col-duration necto-numeric" }, [t("Duration")]),
    el("th", { class: "col-size necto-numeric" }, [t("Size")]),
  ]);

  const rows = visible.map((record) => {
    const row = el(
      "tr",
      {
        "aria-selected": record.id === selectedID ? "true" : undefined,
        "data-failed": isFailure(record) ? "true" : undefined,
      },
      [
        el("td", {}, [statusCell(record)]),
        el("td", { class: "cell-method" }, [record.method]),
        el("td", {}, [el("span", { class: "req-name" }, [record.name]), el("span", { class: "req-host" }, [record.host])]),
        el("td", { class: "cell-type" }, [record.resourceType ?? ""]),
        el("td", { class: "cell-started cell-numeric necto-numeric" }, [clock(record.startedAtMilliseconds)]),
        el("td", { class: "cell-duration cell-numeric necto-numeric" }, [formatDuration(record)]),
        el("td", { class: "cell-size cell-numeric necto-numeric" }, [formatBytes(record.responseByteCount)]),
      ],
    );
    row.addEventListener("click", () => void select(record.id));
    return row;
  });

  listPane.append(el("table", { class: "necto-table" }, [el("thead", {}, [head]), el("tbody", {}, rows)]));
}

function renderConsole(): void {
  const visible = visibleEntries();
  count.textContent = visible.length ? String(visible.length) : "";
  if (!visible.length) {
    listPane.append(empty(t("No messages yet"), t("Console output and uncaught errors from the page appear here.")));
    return;
  }

  const head = el("tr", {}, [
    el("th", { class: "col-level" }, [t("Level")]),
    el("th", { class: "col-started necto-numeric" }, [t("Time")]),
    el("th", {}, [t("Message")]),
    el("th", { class: "col-source" }, [t("Source")]),
  ]);
  const rows = visible.map((entry) =>
    el("tr", { "data-level": entry.level }, [
      el("td", {}, [el("span", { class: `necto-status necto-status-${levelTone[entry.level]}` }, [entry.level])]),
      el("td", { class: "cell-started cell-numeric necto-numeric" }, [clock(entry.timestampMilliseconds)]),
      el("td", { class: "console-text" }, [entry.text]),
      el("td", { class: "cell-source" }, [entry.location ?? entry.source]),
    ]),
  );
  listPane.append(el("table", { class: "necto-table" }, [el("thead", {}, [head]), el("tbody", {}, rows)]));
}

function renderDetail(): void {
  detailPane.unmount();
  detailSlot.replaceChildren();
  if (view !== "network" || !selectedID) return;
  const record = network.records.get(selectedID);
  if (!record) return;

  const close = el("button", { type: "button", class: "necto-button necto-button-quiet", "aria-label": t("Close details") }, ["✕"]);
  close.addEventListener("click", closeDetail);

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "summary", label: t("Summary") },
    { id: "request", label: t("Request") },
    { id: "response", label: t("Response") },
    { id: "curl", label: "cURL" },
  ];

  const aside = el("aside", { class: "necto-detail" }, [
    el("div", { class: "necto-detail-title necto-detail-title-wrap" }, [
      statusCell(record),
      el("span", { class: "cell-method" }, [record.method]),
      el("span", { class: "necto-detail-title-url" }, [record.url]),
      close,
    ]),
    el(
      "div",
      { class: "necto-tabs" },
      tabs.map(({ id, label }) => {
        const button = el("button", { type: "button", class: "necto-tab", "aria-selected": detailTab === id ? "true" : "false" }, [label]);
        button.addEventListener("click", () => {
          detailTab = id;
          renderDetail();
        });
        return button;
      }),
    ),
    el("div", { class: "necto-detail-body" }, detailBody(record)),
  ]);

  detailSlot.append(aside);
  detailPane.mount(aside);
}

function detailBody(record: NetworkRecord): Node[] {
  if (detailTab === "summary") {
    const rows: [string, string][] = [[t("Method"), record.method], [t("State"), record.state]];
    if (record.statusCode !== undefined) rows.push([t("Status"), String(record.statusCode)]);
    if (record.resourceType) rows.push([t("Type"), record.resourceType]);
    if (record.durationMilliseconds !== undefined) rows.push([t("Duration"), `${Math.round(record.durationMilliseconds)} ms`]);
    if (record.responseByteCount !== undefined) rows.push([t("Size"), formatBytes(record.responseByteCount)]);
    rows.push([t("Started"), new Date(record.startedAtMilliseconds).toLocaleString()]);
    if (record.redirectedTo) rows.push([t("Redirected to"), record.redirectedTo]);
    if (record.errorSummary) rows.push([t("Error"), record.errorSummary]);
    return [pairs(rows)];
  }

  if (detailTab === "curl") return [codeBlock(curlCommand(record))];

  const headers = detailTab === "request" ? record.requestHeaders : record.responseHeaders;
  const sorted = Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const nodes: Node[] = [el("h3", { class: "necto-section-title" }, [t("Headers")]), pairs(sorted)];
  nodes.push(el("h3", { class: "necto-section-title" }, [t("Body")]));

  if (detailTab === "request") {
    const contentType = record.requestHeaders["Content-Type"] ?? record.requestHeaders["content-type"];
    nodes.push(
      record.requestBody === undefined
        ? el("p", { class: "necto-caption" }, [t("No request body.")])
        : codeBlock(formatBody(record.requestBody, contentType)),
    );
  } else if (!responseBody) {
    nodes.push(el("p", { class: "necto-caption" }, [t("Loading…")]));
  } else if (responseBody.note !== undefined) {
    nodes.push(el("p", { class: "necto-caption" }, [responseBody.note]));
  } else if (responseBody.error !== undefined) {
    nodes.push(el("p", { class: "necto-caption" }, [t("Response body unavailable: {reason}", { reason: responseBody.error })]));
  } else {
    nodes.push(codeBlock(formatBody(responseBody.text ?? "", record.mimeType)));
  }
  return nodes;
}

function renderAll(): void {
  renderToolbar();
  renderList();
  renderDetail();
}

/// Events can arrive by the hundred while a page loads. One render per frame keeps the
/// filter field responsive.
let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
    renderDetail();
  });
}

// -- actions -----------------------------------------------------------------

/// Bumped by every selection, close and disconnect. A body that comes back under an
/// older token belongs to a view that is gone, however the ids line up.
let bodyToken = 0;
let bodyRequested = false;

function select(id: string): void {
  selectedID = id;
  responseBody = null;
  bodyRequested = false;
  bodyToken += 1;
  renderList();
  renderDetail();
  void loadBodyIfReady();
}

/// Asked for once the selected request has finished: the browser has no body before
/// that, and fetching every body as it arrives would double a heavy page's traffic.
async function loadBodyIfReady(): Promise<void> {
  const record = selectedID ? network.records.get(selectedID) : undefined;
  if (!record || bodyRequested || responseBody) return;

  if (record.bodyUnavailable) {
    responseBody = { note: t("A redirect hop has no body of its own.") };
    renderDetail();
    return;
  }
  const source = session;
  if (!source || record.state === "pending") return;

  bodyRequested = true;
  const token = bodyToken;
  try {
    const result = await source.send("Network.getResponseBody", { requestId: record.requestID });
    if (token !== bodyToken) return;
    const text = String(result.body ?? "");
    responseBody = { text: result.base64Encoded === true ? `base64 · ${text.length} chars` : text };
  } catch (error) {
    if (token !== bodyToken) return;
    responseBody = { error: error instanceof Error ? error.message : String(error) };
  }
  renderDetail();
}

function closeDetail(): void {
  selectedID = null;
  responseBody = null;
  bodyRequested = false;
  bodyToken += 1;
  renderList();
  renderDetail();
}

async function findTabs(): Promise<void> {
  const port = parsePort(portField.value);
  if (port === null) {
    status = t("Enter a port between 1 and 65535.");
    renderToolbar();
    return;
  }
  remember("necto-web.port", String(port));
  status = t("Looking for tabs…");
  renderToolbar();

  try {
    targets = await listTargets(port);
    status = targets.length ? t("{count} tabs", { count: String(targets.length) }) : t("No debuggable tabs on this port.");
  } catch (error) {
    targets = [];
    status = error instanceof Error ? error.message : String(error);
  }
  renderToolbar();
}

function handleEvent(method: string, params: Record<string, unknown>): void {
  if (method.startsWith("Network.")) {
    const changed = network.apply(method, params);
    if (!changed) return;
    scheduleRender();
    // The selected request may just have finished; its body can be asked for now.
    if (changed === selectedID) void loadBodyIfReady();
    return;
  }
  const entry = consoleEntry(method, params, ++consoleID);
  if (!entry) return;
  consoleEntries.push(entry);
  if (consoleEntries.length > MAX_CONSOLE) consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE);
  scheduleRender();
}

/// The session being opened. Only it or the open `session` may add records, so a socket
/// left over from an earlier attempt can never write into the list.
let opening: CdpSession | null = null;

async function connect(): Promise<void> {
  if (opening) return;
  const target = targets.find((candidate) => candidate.id === targetPicker.value) ?? targets[0];
  if (!target) return;
  remember("necto-web.target", target.id);

  // Records belong to the session that saw them: request ids mean nothing to another
  // tab, and a body asked for through the wrong socket would be someone else's.
  session?.close();
  session = null;
  network.clear();
  consoleEntries.length = 0;
  closeDetail();

  const next = new CdpSession(target.webSocketDebuggerUrl);
  opening = next;
  next.onEvent = (method, params) => {
    if (session === next || opening === next) handleEvent(method, params);
  };
  next.onClose = (reason) => {
    if (session !== next) return;
    session = null;
    bodyToken += 1;
    status = t("Disconnected: {reason}", { reason });
    renderAll();
  };
  status = t("Connecting…");
  renderToolbar();

  try {
    await next.connect();
    if (opening !== next) {
      next.close();
      return;
    }
    session = next;
    connectedTitle = target.title || target.url;
    await Promise.all([
      next.send("Network.enable", { maxPostDataSize: 65536 }),
      next.send("Runtime.enable"),
      next.send("Log.enable"),
    ]);
    if (session !== next) return;
    status = t("Connected to {title}", { title: connectedTitle });
  } catch (error) {
    next.close();
    // An attempt that was canceled, or replaced by a newer one, has nothing to say
    // about the connection on screen now.
    const current = session === next || opening === next;
    if (session === next) session = null;
    if (!current) return;
    status = error instanceof Error ? error.message : String(error);
  } finally {
    if (opening === next) opening = null;
  }
  renderAll();
}

function disconnect(): void {
  const current = session ?? opening;
  session = null;
  opening = null;
  bodyToken += 1;
  current?.close();
  status = t("Not connected");
  renderAll();
}

findButton.addEventListener("click", () => void findTabs());
portField.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void findTabs();
});
connectButton.addEventListener("click", () => (session || opening ? disconnect() : void connect()));
reloadButton.addEventListener("click", () => void session?.send("Page.reload", { ignoreCache: false }));

filterField.addEventListener("input", () => {
  if (view === "network") networkQuery = filterField.value;
  else consoleQuery = filterField.value;
  renderList();
});

clearButton.addEventListener("click", () => {
  if (view === "network") {
    // Only the panel's list. The browser's own cache and state are not ours to touch.
    network.clear();
  } else {
    consoleEntries.length = 0;
  }
  closeDetail();
});

listPane.addEventListener("keydown", (event) => {
  if (view !== "network") return;
  if (event.key === "Escape") {
    closeDetail();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const visible = visibleRecords();
  const index = visible.findIndex((record) => record.id === selectedID);
  const target = visible[Math.max(0, Math.min(visible.length - 1, event.key === "ArrowDown" ? index + 1 : index - 1))];
  if (target) void select(target.id);
});

// -- start -------------------------------------------------------------------

renderAll();
if (necto.isAvailable()) void necto.ready();
