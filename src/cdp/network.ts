//
// Copyright (c) 2026 AI-Dico
//

import { ExtraInfoSlots } from "./extra-info.ts";

/// A request as the panel shows it. The field names follow Necto's own network
/// records, so the same table and detail pane read both.
export interface NetworkRecord {
  id: string;
  requestID: string;
  method: string;
  url: string;
  name: string;
  host: string;
  resourceType?: string;
  state: "pending" | "finished" | "failed";
  statusCode?: number;
  mimeType?: string;
  startedAtMilliseconds: number;
  durationMilliseconds?: number;
  responseByteCount?: number;
  errorSummary?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  /// Set when the response was a redirect; the follow-up is a record of its own.
  redirectedTo?: string;
  /// The browser keeps one body per request id, the final hop's. A redirect hop shares
  /// the id, so asking for its body would return the wrong one.
  bodyUnavailable?: boolean;
}

/// How many records a long session keeps. Polling pages add rows forever; the oldest
/// go first.
export const MAX_RECORDS = 1000;

type Params = Record<string, unknown>;

function object(value: unknown): Params {
  return typeof value === "object" && value !== null ? (value as Params) : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function headers(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, header] of Object.entries(object(value))) {
    result[name] = String(header);
  }
  return result;
}

/// The path is the subject of a row and the host is context beside it.
export function describeURL(url: string): { name: string; host: string } {
  if (url.startsWith("data:")) return { name: url.slice(0, 32), host: "data" };
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const name = (segments.at(-1) ?? "") + parsed.search || parsed.host;
    return { name, host: parsed.host };
  } catch {
    return { name: url, host: "" };
  }
}

/// Folds `Network.*` events into records. Each method returns the id of the record it
/// changed, or null when the event was not one it keeps.
///
/// Times: `wallTime` (seconds since the epoch) arrives only with the request, and every
/// later event carries the monotonic `timestamp` (seconds). Durations are taken between
/// monotonic timestamps; the wall clock only places the start.
///
/// `*ExtraInfo` events carry what actually crossed the wire (a 304 that the cache turned
/// into a 200, the headers sent with cookies, the response of a CORS failure). They win
/// over the plain events, whichever arrives first; `ExtraInfoSlots` pairs them.
export class NetworkLog {
  readonly records = new Map<string, NetworkRecord>();
  private readonly started = new Map<string, number>();
  private readonly requestExtra = new ExtraInfoSlots<Params, NetworkRecord>();
  private readonly responseExtra = new ExtraInfoSlots<Params, NetworkRecord>();
  private redirects = 0;
  private readonly limit: number;

  constructor(limit = MAX_RECORDS) {
    this.limit = limit;
  }

  apply(method: string, params: Params): string | null {
    switch (method) {
      case "Network.requestWillBeSent":
        return this.requestWillBeSent(params);
      case "Network.requestWillBeSentExtraInfo":
        return this.offer(this.requestExtra, params, applyRequestExtra);
      case "Network.responseReceived":
        return this.responseReceived(params);
      case "Network.responseReceivedExtraInfo":
        return this.offer(this.responseExtra, params, applyResponseExtra);
      case "Network.loadingFinished":
        return this.loadingFinished(params);
      case "Network.loadingFailed":
        return this.loadingFailed(params);
      default:
        return null;
    }
  }

  clear(): void {
    this.records.clear();
    this.started.clear();
    this.requestExtra.clear();
    this.responseExtra.clear();
  }

  /// For tests: how many ids the ExtraInfo queues are holding.
  get pendingExtraInfo(): number {
    return this.requestExtra.size + this.responseExtra.size;
  }

  private offer(
    slots: ExtraInfoSlots<Params, NetworkRecord>,
    params: Params,
    fold: (record: NetworkRecord, info: Params) => void,
  ): string | null {
    const requestID = String(params.requestId ?? "");
    if (!requestID) return null;
    const record = slots.arrive(requestID, params);
    if (!record) return null;
    fold(record, params);
    // The record may have been evicted while it waited.
    return this.records.get(record.id) === record ? record.id : null;
  }

  private trim(): void {
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) return;
      const record = this.records.get(oldest);
      this.records.delete(oldest);
      // The ExtraInfo slots stay: the request may still be running, and its later
      // events have to line up with the positions it already used. Only the timing
      // of a finished request goes.
      if (record && record.id === record.requestID && record.state !== "pending") {
        this.started.delete(record.requestID);
      }
    }
  }

  private requestWillBeSent(params: Params): string | null {
    const requestID = String(params.requestId ?? "");
    if (!requestID) return null;
    const request = object(params.request);
    const timestamp = number(params.timestamp) ?? 0;

    // The browser reuses the request id across a redirect. The finished hop moves to
    // an id of its own so the follow-up does not overwrite it.
    const previous = this.records.get(requestID);
    const redirect = object(params.redirectResponse);
    const isRedirect = Object.keys(redirect).length > 0;
    // The hop's slot is claimed even when its record was trimmed away, so the final
    // response's ExtraInfo does not take the hop's position.
    if (isRedirect && !previous && params.redirectHasExtraInfo === true) {
      this.responseExtra.claim(requestID, null);
    }
    if (previous && isRedirect) {
      this.redirects += 1;
      const hopID = `${requestID}#${this.redirects}`;
      const startedAt = this.started.get(requestID);
      this.records.delete(requestID);
      // Moved, not copied: if this hop is still waiting for its request ExtraInfo, the
      // waiting entry is this same object and keeps pointing at the right hop.
      Object.assign(previous, {
        id: hopID,
        state: "finished",
        statusCode: number(redirect.status),
        mimeType: typeof redirect.mimeType === "string" ? redirect.mimeType : undefined,
        responseHeaders: headers(redirect.headers),
        durationMilliseconds:
          startedAt === undefined ? undefined : Math.max(0, (timestamp - startedAt) * 1000),
        redirectedTo: typeof request.url === "string" ? request.url : undefined,
        bodyUnavailable: true,
      });
      if (params.redirectHasExtraInfo === true) {
        const info = this.responseExtra.claim(requestID, previous);
        if (info) applyResponseExtra(previous, info);
      }
      this.records.set(hopID, previous);
    }

    const url = typeof request.url === "string" ? request.url : "";
    const wallTime = number(params.wallTime);
    this.started.set(requestID, timestamp);
    const record: NetworkRecord = {
      id: requestID,
      requestID,
      method: typeof request.method === "string" ? request.method : "GET",
      url,
      ...describeURL(url),
      resourceType: typeof params.type === "string" ? params.type : undefined,
      state: "pending",
      startedAtMilliseconds: wallTime === undefined ? Date.now() : wallTime * 1000,
      requestHeaders: headers(request.headers),
      requestBody: typeof request.postData === "string" ? request.postData : undefined,
    };
    this.records.set(requestID, record);
    // Every hop that reaches the network sends one request ExtraInfo, before or after
    // this event; each hop claims the next position.
    const sent = this.requestExtra.claim(requestID, record);
    if (sent) applyRequestExtra(record, sent);
    this.trim();
    return requestID;
  }

  private responseReceived(params: Params): string | null {
    const requestID = String(params.requestId ?? "");
    const record = this.records.get(requestID);
    if (!record) {
      // Trimmed away, but its position still counts.
      if (requestID && params.hasExtraInfo === true) this.responseExtra.claim(requestID, null);
      return null;
    }
    const response = object(params.response);

    record.statusCode = number(response.status);
    record.mimeType = typeof response.mimeType === "string" ? response.mimeType : undefined;
    record.responseHeaders = headers(response.headers);
    // Request headers as sent can differ from the ones announced with the request
    // (cookies, the browser's own additions); the sent ones are the truth.
    const sent = object(response.requestHeaders);
    if (Object.keys(sent).length) record.requestHeaders = headers(sent);
    if (params.hasExtraInfo === true) {
      const info = this.responseExtra.claim(record.requestID, record);
      if (info) applyResponseExtra(record, info);
    }
    return record.id;
  }

  private loadingFinished(params: Params): string | null {
    const requestID = String(params.requestId ?? "");
    this.requestExtra.finish(requestID);
    this.responseExtra.finish(requestID);
    const record = this.records.get(requestID);
    if (!record) return null;
    this.finish(record, number(params.timestamp));
    record.state = "finished";
    record.responseByteCount = number(params.encodedDataLength);
    return record.id;
  }

  private loadingFailed(params: Params): string | null {
    const requestID = String(params.requestId ?? "");
    this.requestExtra.finish(requestID);
    this.responseExtra.finish(requestID);
    const record = this.records.get(requestID);
    if (!record) return null;
    this.finish(record, number(params.timestamp));
    record.state = "failed";
    const reason = typeof params.errorText === "string" ? params.errorText : "failed";
    record.errorSummary = params.canceled === true ? `${reason} (canceled)` : reason;
    // A CORS block had a response on the wire that only ExtraInfo describes; a DNS
    // error had none. The record takes the next ExtraInfo only if one comes.
    if (record.responseHeaders === undefined) {
      const info = this.responseExtra.claimIfArrives(record.requestID, record);
      if (info) applyResponseExtra(record, info);
    }
    return record.id;
  }

  private finish(record: NetworkRecord, timestamp: number | undefined): void {
    const startedAt = this.started.get(record.requestID);
    if (timestamp !== undefined && startedAt !== undefined) {
      record.durationMilliseconds = Math.max(0, (timestamp - startedAt) * 1000);
    }
    this.started.delete(record.requestID);
  }
}

function applyRequestExtra(record: NetworkRecord, info: Params): void {
  const sent = object(info.headers);
  if (Object.keys(sent).length) record.requestHeaders = headers(sent);
}

function applyResponseExtra(record: NetworkRecord, info: Params): void {
  const status = number(info.statusCode);
  if (status !== undefined) record.statusCode = status;
  const wire = object(info.headers);
  if (Object.keys(wire).length) record.responseHeaders = headers(wire);
}

/// A command that repeats the request, for pasting into a terminal.
export function curlCommand(record: NetworkRecord): string {
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const parts = ["curl", quote(record.url)];
  // The method is page controlled too: `X\`pwd\`` is a valid HTTP token.
  if (record.method !== "GET") parts.push("-X", quote(record.method));
  for (const [name, value] of Object.entries(record.requestHeaders)) {
    if (name.startsWith(":")) continue;
    parts.push("-H", quote(`${name}: ${value}`));
  }
  if (record.requestBody !== undefined) parts.push("--data-raw", quote(record.requestBody));
  return parts.join(" ");
}
