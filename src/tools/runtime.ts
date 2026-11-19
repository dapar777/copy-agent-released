import { execFile } from "child_process";
import type { RuntimeInfo } from "../protocol/prompt";

/**
 * Zjistí, čím jde na tomto počítači pouštět skripty (Python, Node.js). Model se to dozví v promptu,
 * aby nepsal skripty v jazyce, který tu není, a na Windows nesahal bez důvodu po PowerShellu.
 */

export type Probe = (cmd: string, args: string[]) => Promise<string>;

const TIMEOUT_MS = 4000;

/** Výstup příkazu (stdout i stderr); prázdný řetězec, když příkaz neexistuje nebo nedoběhne. */
const run: Probe = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1 << 16 }, (err, stdout, stderr) => {
      resolve(err ? "" : `${String(stdout ?? "")}\n${String(stderr ?? "")}`);
    });
  });

/**
 * Na Windows bývá `python` jen zástupce z Microsoft Store, který nic nespustí: bere se až příkaz,
 * který opravdu vypíše verzi. Pořadí: `python`, launcher `py -3`, `python3` (jinde `python3` napřed).
 */
export async function detectRuntime(platform: string = process.platform, probe: Probe = run): Promise<RuntimeInfo> {
  const candidates: [string, string[]][] = platform === "win32" ? [["python", []], ["py", ["-3"]], ["python3", []]] : [["python3", []], ["python", []]];
  const info: RuntimeInfo = { platform };
  const [pythons, node] = await Promise.all([Promise.all(candidates.map(([cmd, args]) => probe(cmd, [...args, "--version"]))), probe("node", ["--version"])]);
  pythons.some((out, i) => {
    const version = /Python (3\.\d+(?:\.\d+)?)/.exec(out)?.[1];
    if (version) info.python = { command: [candidates[i][0], ...candidates[i][1]].join(" "), version };
    return !!version;
  });
  const nodeVersion = /v(\d+\.\d+\.\d+)/.exec(node)?.[1];
  if (nodeVersion) info.node = nodeVersion;
  return info;
}

let cached: Promise<RuntimeInfo> | undefined;

/** Zjišťuje se jednou za běh rozšíření; instalace Pythonu během práce se projeví po restartu VS Code. */
export function runtimeInfo(): Promise<RuntimeInfo> {
  return (cached ??= detectRuntime());
}
