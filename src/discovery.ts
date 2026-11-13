//
// Copyright (c) 2026 AI-Dico
//

import { hasErrorCode, necto } from "@necto/bridge";

import { DISCOVERY_COMMAND, parseTargets, type DevToolsTarget } from "./cdp/targets";
import { t } from "./localization";

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Authorization {
  approved: boolean;
  approvedCommands: string[];
}

/// The panel cannot read `/json/list` itself: Chrome sends no CORS header, so the
/// WebView refuses the response. The approved shell command reads it instead.
async function runDiscovery(port: number): Promise<ShellResult> {
  return necto.desktop.send<ShellResult & Record<string, never>>("shell.execute", {
    command: DISCOVERY_COMMAND,
    stdin: `${port}\n`,
  });
}

async function requestApproval(): Promise<boolean> {
  const answer = await necto.desktop.send<Authorization & Record<string, never>>("shell.request", {
    access: "commandApproval",
    commands: [DISCOVERY_COMMAND],
    title: t("List browser tabs"),
    message: t(
      "Web reads the list of debuggable tabs from a local DevTools port with curl. The port is passed separately, so this one approval covers every port.",
    ),
  });
  return answer.approved && answer.approvedCommands.includes(DISCOVERY_COMMAND);
}

export async function listTargets(port: number): Promise<DevToolsTarget[]> {
  let result: ShellResult;
  try {
    result = await runDiscovery(port);
  } catch (error) {
    if (!hasErrorCode(error, "PERMISSION_DENIED")) throw error;
    if (!(await requestApproval())) throw new Error(t("Tab discovery was not approved."));
    result = await runDiscovery(port);
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    throw new Error(t("Nothing answered on port {port}: {detail}", { port: String(port), detail }));
  }
  return parseTargets(result.stdout);
}
