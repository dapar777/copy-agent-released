import { describe, expect, it } from "vitest";
import { buildAgentInstructions, buildContinuePrompt, buildCorrectionPrompt, buildInitialPrompt, buildResultsPrompt, buildSuggestPrompt, DEFAULT_OPTIONS, environmentSection, ProjectContext, renderResult, runOutputLimit, splitPrompt } from "../src/protocol/prompt";
import { TOOLS } from "../src/protocol/schema";

const ctx: ProjectContext = { workspaceName: "demo", tree: "src/a.ts\npackage.json" };

describe("agent instructions", () => {
  it("fit the Copilot Agent Builder limit and describe every tool", () => {
    const text = buildAgentInstructions();
    expect(text.length).toBeLessThanOrEqual(8000);
    for (const t of TOOLS) expect(text).toContain(`<${t.name}`);
    expect(text).toContain("````");
    expect(text).toContain("part=");
    expect(text).toContain("[PART i/n]");
    expect(text).toMatch(/FEWEST REPLIES/);
  });
});

describe("prompts", () => {
  it("initial prompt for the copilot agent is short and names session and turn", () => {
    const p = buildInitialPrompt("s1", "Přidej validaci", ctx, DEFAULT_OPTIONS);
    expect(p).toContain("# Copy Agent session");
    expect(p).toContain('<copy turn="1" session="s1">');
    expect(p).not.toContain("## Actions");
    expect(p.length).toBeLessThan(3000);
  });

  it("generic initial prompt carries the whole protocol", () => {
    const p = buildInitialPrompt("s1", "task", ctx, { ...DEFAULT_OPTIONS, target: "generic" });
    expect(p).toContain("## Actions");
    expect(p).toContain("## Rules");
  });

  it("mentions an attached codebase bundle", () => {
    const p = buildInitialPrompt("s1", "task", { ...ctx, initialBundle: { file: ".copy-agent/out/bundle-1-0-x.txt", files: 12, chars: 34000, skipped: 1 } }, DEFAULT_OPTIONS);
    expect(p).toContain("## Attached: the complete codebase");
    expect(p).toContain("12 text files");
  });

  it("results prompt defers oversized results instead of truncating file content", () => {
    const big = "x".repeat(20000);
    const p = buildResultsPrompt("s1", 3, [{ tool: "read", attrs: { path: "a.ts" }, status: "ok", output: big }, { tool: "read", attrs: { path: "b.ts" }, status: "ok", output: big }], {}, { ...DEFAULT_OPTIONS, maxChars: 8000, maxParts: 3 });
    expect(p).toContain('<result of="read" path="a.ts" status="ok">');
    expect(p).toContain('path="b.ts" status="skipped" deferred="prompt size limit"');
    expect(p).toContain('<copy turn="3" session="s1">');
  });

  it("continue prompt asks for the next part only", () => {
    const p = buildContinuePrompt("s1", 2, 1, 3, "cs");
    expect(p).toContain('part="2/3"');
    expect(p).toContain("Mám část 1/3");
  });

  it("correction prompt suggests the fenced block", () => {
    const p = buildCorrectionPrompt("s1", 2, ["No block"], { prose: "Here is what I think?", attempt: 2 });
    expect(p).toContain("<protocol-error>No block</protocol-error>");
    expect(p).toContain("correction attempt 2");
  });
});

describe("output of a successful command", () => {
  const out = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
  const r = { tool: "run", attrs: {}, status: "ok" as const, output: out, fullOutputPath: ".copy-agent/out/run-1-0.txt" };

  it("gives the model the end of it, 15 000 characters by default, more or less by the setting", () => {
    const def = renderResult(r, DEFAULT_OPTIONS);
    expect(def).toContain("line 2000");
    expect(def).not.toContain("line 100\n");
    expect(def.length).toBeGreaterThan(14000);
    expect(def.length).toBeLessThan(15400);
    expect(def).toContain('Full output: <read path=".copy-agent/out/run-1-0.txt"/>');
    expect(renderResult(r, { ...DEFAULT_OPTIONS, runOutputMaxChars: 3000 }).length).toBeLessThan(3400);
    expect(renderResult(r, { ...DEFAULT_OPTIONS, runOutputMaxChars: 50000 })).toContain("line 1\n");
    expect(runOutputLimit({ runOutputMaxChars: 10 })).toBe(500);
    expect(runOutputLimit({})).toBe(15000);
  });
});

describe("environment and script language", () => {
  const win = { platform: "win32", python: { command: "py -3", version: "3.11.4" }, node: "20.11.0" };

  it("tells the model the shell, what is installed and to write scripts in Python", () => {
    const text = environmentSection(win).join("\n");
    expect(text).toContain("Windows; <run> executes through cmd.exe (not PowerShell)");
    expect(text).toContain("Python 3.11.4 is installed (run it as `py -3`)");
    expect(text).toMatch(/SCRIPTS: .*write it in Python \(standard library only.*run with `py -3 <file>\.py`/);
    expect(text).toContain("Do not write PowerShell (.ps1) or batch (.cmd/.bat) scripts");
  });

  it("falls back when the preferred language is not installed and says so", () => {
    const noPython = environmentSection({ platform: "win32", node: "20.11.0" }).join("\n");
    expect(noPython).toContain("Python is NOT installed.");
    expect(noPython).toContain("write it in Node.js");
    expect(noPython).toContain("(Python was preferred but is not available here)");
    const nothing = environmentSection({ platform: "win32" }).join("\n");
    expect(nothing).toContain("write it in PowerShell");
    expect(nothing).not.toContain("Do not write PowerShell");
    expect(environmentSection({ platform: "linux" }).join("\n")).toContain("write it in Bash");
  });

  it("honours the setting: another language, or no preference at all", () => {
    expect(environmentSection(win, "node").join("\n")).toContain("write it in Node.js (built-in modules only");
    expect(environmentSection(win, "powershell").join("\n")).toMatch(/write it in PowerShell.*\. Use another language only when/);
    const auto = environmentSection(win, "auto").join("\n");
    expect(auto).toContain("Python 3.11.4 is installed");
    expect(auto).not.toContain("SCRIPTS:");
  });

  it("is part of the task context and of the suggestion prompt", () => {
    const withEnv: ProjectContext = { ...ctx, env: { runtime: win, scripts: "python" } };
    expect(buildInitialPrompt("s1", "task", withEnv, DEFAULT_OPTIONS)).toContain("## Environment");
    expect(buildInitialPrompt("s1", "task", ctx, DEFAULT_OPTIONS)).not.toContain("## Environment");
    expect(buildSuggestPrompt("s1", 4, "history", withEnv, DEFAULT_OPTIONS)).toContain("SCRIPTS: whenever the task");
  });
});

describe("splitPrompt", () => {
  it("returns the text unchanged when it fits", () => {
    expect(splitPrompt("short", 100)).toEqual(["short"]);
  });

  it("splits on line boundaries with PART headers and a LAST marker", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n");
    const parts = splitPrompt(lines, 3000, "cs");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3000);
    expect(parts[0]).toMatch(/^\[PART 1\/\d+\]/);
    expect(parts[parts.length - 1]).toMatch(/LAST/);
    const joined = parts.map((p) => p.replace(/^\[PART[^\n]*\n\n/, "")).join("\n");
    expect(joined).toBe(lines);
  });
});

describe("copilot-agent/INSTRUCTIONS.md", () => {
  it("is up to date with the generated instructions (run: node dist/gen-instructions.js --write)", async () => {
    const fs = await import("fs");
    const onDisk = fs.readFileSync("copilot-agent/INSTRUCTIONS.md", "utf8").replace(/\r\n/g, "\n").trim();
    expect(onDisk).toBe(buildAgentInstructions().trim());
  });
});
