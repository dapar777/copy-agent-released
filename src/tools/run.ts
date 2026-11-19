import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";
import { isAutoAllowedCommand, isDeniedCommand } from "../safety/Policy";
import { takeScreenshot } from "./screenshot";

/**
 * PowerShell startuje pomalu a nejvíc ho zdržuje načítání profilu uživatele. Příkaz, který PowerShell
 * volá bez `-NoProfile`, ho dostane (spolu s `-NonInteractive`, ať se nikdy nezasekne na dotazu).
 * Týká se jen samotného volání `powershell`/`pwsh` na začátku příkazu nebo za `&&`, `||`, `;`, `|`.
 */
export function tunePowerShell(command: string): string {
  return command.replace(/(^|&&|\|\||[;|(]|\bcall\s)(\s*)((?:"[^"]*\\)?(?:powershell|pwsh)(?:\.exe)?"?)(?=\s|$)([^&|;]*)/gi, (whole, sep: string, ws: string, exe: string, rest: string) => {
    if (/(^|\s)-(nop|noprofile)\b/i.test(rest)) return whole;
    return `${sep}${ws}${exe} -NoProfile -NonInteractive${rest}`;
  });
}

/**
 * Příkaz, který přes shell hledá v souborech, vypisuje je nebo čte: totéž umí akce agenta okamžitě
 * z indexu, bez schvalování a bez ořezání výstupu. Vrací radu pro model, nebo prázdný text.
 */
export function shellSearchHint(command: string): string {
  const c = command.toLowerCase();
  const search = /\b(select-string|sls|findstr|grep|rg|ag|ack)\b/.test(c);
  const list = /\b(get-childitem|gci|dir\s+\/s|dir\s+-r|ls\s+-r|find\s+[.\w\\/]|tree)\b/.test(c);
  const read = /^\s*(?:powershell[^|&]*?\s)?(get-content|gc|type|cat|more|head|tail)\b/.test(c) || /\|\s*(select-object|select)\s+-(first|last|skip)/.test(c);
  if (!search && !list && !read) return "";
  const what = [search ? "<grep pattern=…> (and the tools symbols, usages) for searching" : "", list ? "<glob>/<ls> (and the tool files) for listing" : "", read ? '<read path=… lines="A-B"> for reading' : ""].filter(Boolean).join(", ");
  return `[hint: this went through a shell. The agent's own actions do it instantly from the workspace index, need no approval and are not cut: ${what}. Use them next time.]`;
}

export async function toolRun(host: Host, attrs: Record<string, string>, body: string, turn = 0, index = 0, signal?: AbortSignal): Promise<ActionResult> {
  const command = body.trim();
  const meta: Record<string, string | number> = { command: command.split("\n")[0].slice(0, 200) };
  const denied = isDeniedCommand(command, host.policy);
  if (denied) return { tool: "run", attrs, status: "denied", output: `Command blocked by policy (matches "${denied}").`, meta };
  const cwd = attrs.cwd || ".";
  if (cwd !== ".") host.assertInside(cwd);
  if (!isAutoAllowedCommand(command, host.policy)) {
    const ok = await host.confirmCommand(command, cwd);
    if (!ok) return { tool: "run", attrs, status: "denied", output: "The user declined to run this command.", meta };
  }
  const timeoutMs = Math.min(1800, Math.max(5, Number(attrs.timeout) || 120)) * 1000;
  const captureMs = attrs.capture ? Math.min(120, Math.max(1, Number(attrs.capture) || 3)) * 1000 : undefined;
  let probeMs = attrs.probe ? Math.min(120, Math.max(1, Number(attrs.probe) || 5)) * 1000 : undefined;
  if (captureMs && (!probeMs || probeMs <= captureMs)) probeMs = captureMs + 1500;
  // PowerShell bez profilu startuje znatelně rychleji (jde vypnout nastavením)
  const tuned = host.policy.powershellNoProfile === false ? command : tunePowerShell(command);
  host.log(`$ ${tuned}${probeMs ? ` (probe ${probeMs / 1000}s)` : ""}${captureMs ? ` (capture ${captureMs / 1000}s)` : ""}`);
  const running = host.run(tuned, cwd, timeoutMs, probeMs, signal);
  let shot: ActionResult | undefined;
  if (captureMs) {
    await new Promise((res) => setTimeout(res, captureMs));
    shot = await takeScreenshot(host, turn, index, { window: attrs.window, name: "run" });
  }
  const r = await running;
  const shotNote = shot ? `\n[${shot.output}]` : "";
  const attachments = shot?.attachments;
  const suspended = r.suspendedMs && r.suspendedMs > 5000 ? `[note: the computer was asleep for ${Math.round(r.suspendedMs / 1000)}s while this command ran; that time is not counted]\n` : "";
  if (suspended) meta.suspended = Math.round(r.suspendedMs! / 1000) + "s";
  const duration = (r.durationMs / 1000).toFixed(1) + "s";
  const hint = shellSearchHint(command);
  if (r.interrupted) {
    return {
      tool: "run",
      attrs,
      status: "error",
      output: suspended + `[INTERRUPTED by the user after ${duration}; the process was killed. Partial output follows.]\n` + (r.output || "(no output)"),
      meta: { ...meta, exit: "interrupted", duration },
      attachments,
    };
  }
  if (r.stillRunning) {
    return {
      tool: "run",
      attrs,
      status: "ok",
      output: suspended + `[probe: process was still running after ${probeMs! / 1000}s, so it started successfully; it was then stopped]${shotNote}\n` + (r.output || "(no output)"),
      meta: { ...meta, exit: "running", duration, ...(shot?.meta?.file ? { screenshot: shot.meta.file } : {}) },
      attachments,
    };
  }
  return {
    tool: "run",
    attrs,
    status: r.exit === 0 && !r.timedOut ? "ok" : "error",
    output:
      suspended +
      (r.timedOut ? `[timed out after ${timeoutMs / 1000}s and was killed; for servers or GUI apps use probe="N"]\n` : "") +
      (probeMs && r.exit !== 0 ? `[probe: process exited with code ${r.exit} before ${probeMs / 1000}s elapsed, so it did NOT start properly]\n` : "") +
      (shotNote ? shotNote.trim() + "\n" : "") +
      (r.output || "(no output)") +
      (hint ? `\n${hint}` : ""),
    meta: { ...meta, exit: r.exit, duration, ...(shot?.meta?.file ? { screenshot: shot.meta.file } : {}) },
    attachments,
  };
}
