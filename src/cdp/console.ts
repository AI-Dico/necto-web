//
// Copyright (c) 2026 AI-Dico
//

export type ConsoleLevel = "error" | "warning" | "info" | "log" | "debug";

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  /// Where the line came from: `console`, `exception`, or a browser log source such as
  /// `network` or `security`.
  source: string;
  text: string;
  timestampMilliseconds: number;
  location?: string;
}

type Params = Record<string, unknown>;

function object(value: unknown): Params {
  return typeof value === "object" && value !== null ? (value as Params) : {};
}

const MAX_TEXT = 4000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/// A `Runtime.RemoteObject` as one line: primitives as their value, strings bare (the
/// way a console prints them), objects through their preview when the browser sent one.
export function formatRemoteObject(value: unknown): string {
  const remote = object(value);
  if (typeof remote.unserializableValue === "string") return remote.unserializableValue;
  if (remote.type === "undefined") return "undefined";
  if (remote.subtype === "null") return "null";
  if ("value" in remote && remote.type !== "object") {
    return typeof remote.value === "string" ? remote.value : String(remote.value);
  }

  const preview = object(remote.preview);
  const properties = Array.isArray(preview.properties) ? preview.properties : [];
  if (properties.length) {
    const isArray = preview.subtype === "array";
    const shown = properties.map((property) => {
      const entry = object(property);
      const shownValue = entry.type === "string" ? JSON.stringify(entry.value) : String(entry.value);
      return isArray ? shownValue : `${String(entry.name)}: ${shownValue}`;
    });
    const more = preview.overflow === true ? ", …" : "";
    return isArray ? `[${shown.join(", ")}${more}]` : `{${shown.join(", ")}${more}}`;
  }

  if (typeof remote.description === "string") return remote.description;
  return String(remote.type ?? "");
}

function level(type: unknown): ConsoleLevel {
  switch (type) {
    case "error":
    case "assert":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "info":
      return "info";
    case "debug":
    case "verbose":
      return "debug";
    default:
      return "log";
  }
}

function where(url: unknown, line: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  const file = url.split("/").filter(Boolean).at(-1) ?? url;
  return typeof line === "number" ? `${file}:${line + 1}` : file;
}

/// Turns `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Log.entryAdded`
/// into entries. Returns null for every other event.
export function consoleEntry(method: string, params: Params, id: number): ConsoleEntry | null {
  if (method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params.args) ? params.args : [];
    const callFrames = object(params.stackTrace).callFrames;
    const frame = object(Array.isArray(callFrames) ? callFrames[0] : undefined);
    return {
      id,
      level: level(params.type),
      source: "console",
      text: clip(args.map(formatRemoteObject).join(" ")),
      timestampMilliseconds: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      location: where(frame.url, frame.lineNumber),
    };
  }

  if (method === "Runtime.exceptionThrown") {
    const details = object(params.exceptionDetails);
    const exception = object(details.exception);
    const text =
      typeof exception.description === "string"
        ? exception.description
        : typeof details.text === "string"
          ? details.text
          : "Uncaught exception";
    return {
      id,
      level: "error",
      source: "exception",
      text: clip(text),
      timestampMilliseconds: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      location: where(details.url, details.lineNumber),
    };
  }

  if (method === "Log.entryAdded") {
    const entry = object(params.entry);
    return {
      id,
      level: level(entry.level),
      source: typeof entry.source === "string" ? entry.source : "browser",
      text: clip(typeof entry.text === "string" ? entry.text : ""),
      timestampMilliseconds: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
      location: where(entry.url, entry.lineNumber),
    };
  }

  return null;
}
