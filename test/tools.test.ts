import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeHost } from "../src/host/NodeHost";
import { classifyProse, isOwnPrompt, looksLikeReply, looksLikeTruncatedReply } from "../src/protocol/detect";
import { parseRefs, rangeFor } from "../src/protocol/refs";
import { BUILTIN_COMMANDS, composeTask, parseInput, parseSkillFile } from "../src/protocol/slash";
import { globToRegExp, sanitizeSecrets } from "../src/protocol/text";
import { residue } from "../src/tools/check";
import { collectAutoContext, identifiersFrom } from "../src/tools/context";
import { decodeBytes, detectEncoding, encodeText } from "../src/tools/encoding";
import { toolRead } from "../src/tools/fs";

describe("detect", () => {
  it("recognises replies, own prompts and truncated replies", () => {
    expect(looksLikeReply('<copy turn="2">\n<done>x</done>\n</copy>')).toBe(true);
    expect(looksLikeReply("# Copy Agent session — project x\n<copy turn=\"1\">")).toBe(false);
    expect(isOwnPrompt('[PART 1/2] …\n\n<copy-results turn="1" session="x">')).toBe(true);
    expect(looksLikeTruncatedReply('<copy turn="2">\n<write path="a">\n' + "x".repeat(200))).toBe(true);
    expect(looksLikeReply("plain text")).toBe(false);
  });
  it("classifies prose", () => {
    expect(classifyProse("Which option do you prefer?")).toBe("question");
    expect(classifyProse("# Doc\n\n- a\n- b\n- c\n\n" + "words ".repeat(100))).toBe("document");
  });
});

describe("slash and refs", () => {
  it("parses commands, skills and text", () => {
    const skill = { name: "fix", kind: "skill" as const, description: "d", body: "Do the fix." };
    const p = parseInput("/plan /fix TypeError v x.ts", [...BUILTIN_COMMANDS, skill]);
    expect(p.commands).toEqual(["plan"]);
    expect(p.skills[0].name).toBe("fix");
    expect(p.text).toBe("TypeError v x.ts");
    expect(composeTask(p)).toContain("### Skill /fix");
    expect(parseSkillFile("---\nname: x\ndescription: y\n---\nbody", "f")).toEqual({ name: "x", description: "y", body: "body" });
  });
  it("parses #refs with ranges", () => {
    const refs = parseRefs("see #src/a.ts:10-20 and #file and #selection");
    expect(refs.map((r) => r.kind)).toEqual(["path", "file", "selection"]);
    expect(rangeFor(refs[0], 100)).toEqual({ from: 10, to: 20 });
    expect(rangeFor({ raw: "", path: "x", kind: "path", from: 50, to: 50 }, 100)).toEqual({ from: 30, to: 70 });
  });
});

describe("text", () => {
  it("globs and sanitises secrets", () => {
    expect(globToRegExp("src/**/*.{ts,tsx}").test("src/a/b.tsx")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
    expect(sanitizeSecrets("token=abcdefghijklmnop")).toBe("token=***");
  });
});

describe("check residue", () => {
  it("flags protocol leftovers but not markdown examples", () => {
    expect(residue("a.ts", "<![CDATA[x]]>\n").map((i) => i.severity)).toEqual(["error"]);
    expect(residue("a.ts", "<<<<<<< SEARCH\nx\n")).toHaveLength(1);
    expect(residue("a.md", "<<<<<<< SEARCH\nx\n")).toHaveLength(0);
    expect(residue("a.ts", "```\ncode\n```\n")[0].message).toMatch(/code fence/);
    expect(residue("a.ts", "if (a &lt; b) {}")[0].severity).toBe("warning");
  });
});

describe("encoding", () => {
  it("round-trips windows-1250 and keeps BOM/CRLF", () => {
    const text = "Příliš žluťoučký kůň";
    const buf = encodeText(text, { encoding: "windows-1250", bom: false, eol: "lf" });
    expect(decodeBytes(buf, "windows-1250")).toBe(text);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n", "utf8")]);
    expect(detectEncoding(bom)).toEqual({ encoding: "utf8", bom: true, eol: "crlf" });
  });
});

describe("file tools and auto-context", () => {
  let dir: string;
  let host: NodeHost;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-tools-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "UserService.ts"), "export class UserService {\n  validateEmail(e: string) { return e.includes('@'); }\n}\n");
    fs.writeFileSync(path.join(dir, "src", "other.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "big.ts"), Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    host = new NodeHost(dir, { log: () => undefined });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("read returns an outline for long files without a range", async () => {
    const r = await toolRead(host, { path: "big.ts" });
    expect(r.status).toBe("error");
    expect(r.output).toContain("Outline");
    const part = await toolRead(host, { path: "big.ts", lines: "10-12" });
    expect(part.output).toBe("10| export const v9 = 9;\n11| export const v10 = 10;\n12| export const v11 = 11;");
    expect(part.meta?.lines).toBe("10-12/401");
  });

  it("picks files by identifiers and mentioned paths", async () => {
    expect(identifiersFrom("Oprav validateEmail v UserService")).toEqual(expect.arrayContaining(["validateEmail", "UserService"]));
    const picks = await collectAutoContext(host, "Oprav validateEmail v UserService a src/other.ts", undefined, { maxChars: 10000 });
    expect(picks.map((p) => p.path)).toEqual(expect.arrayContaining(["src/UserService.ts", "src/other.ts"]));
    expect(picks.find((p) => p.path === "src/UserService.ts")?.mode).toBe("full");
  });
});

describe("shell commands", () => {
  it("starts PowerShell without the user profile, wherever it is called", async () => {
    const { tunePowerShell } = await import("../src/tools/run");
    const cases: [string, string][] = [
      ["powershell -File x.ps1", "powershell -NoProfile -NonInteractive -File x.ps1"],
      ["powershell.exe -ExecutionPolicy Bypass -File a.ps1 -Arg 1", "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File a.ps1 -Arg 1"],
      ['pwsh -Command "Get-ChildItem"', 'pwsh -NoProfile -NonInteractive -Command "Get-ChildItem"'],
      ['cd src && powershell -Command "Get-Date"', 'cd src && powershell -NoProfile -NonInteractive -Command "Get-Date"'],
      ['svn status | powershell -Command "$input"', 'svn status | powershell -NoProfile -NonInteractive -Command "$input"'],
      ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -File x.ps1', '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -File x.ps1'],
      // už nastavené nebo vůbec ne volání PowerShellu: beze změny
      ["powershell -NoProfile -File x.ps1", "powershell -NoProfile -File x.ps1"],
      ["pwsh -nop -c x", "pwsh -nop -c x"],
      ["echo powershell is slow", "echo powershell is slow"],
      ["python run.py --shell powershell", "python run.py --shell powershell"],
      ["npm test", "npm test"],
    ];
    for (const [input, want] of cases) expect(tunePowerShell(input), input).toBe(want);
  });

  it("tells the model when a shell command did what an action does instantly", async () => {
    const { shellSearchHint } = await import("../src/tools/run");
    expect(shellSearchHint('powershell -Command "Get-ChildItem -Recurse -Filter *.sql | Select-String vystav_fakturu"')).toMatch(/<grep pattern=…>.*<glob>\/<ls>/);
    expect(shellSearchHint("findstr /s /i vystav_fakturu *.sql")).toMatch(/<grep/);
    expect(shellSearchHint("type db\\pkg_faktury.sql")).toMatch(/<read path=…/);
    expect(shellSearchHint("dir /s /b *.pkb")).toMatch(/<glob>/);
    expect(shellSearchHint("npm test")).toBe("");
    expect(shellSearchHint("svn status")).toBe("");
    expect(shellSearchHint("python tools/build.py")).toBe("");
  });

  it("summarises where a turn spent its time", async () => {
    const { describeTimings } = await import("../src/engine/Transcript");
    expect(describeTimings({ execMs: 120, timings: [{ tool: "grep", target: "x", ms: 100 }] })).toBe("");
    expect(
      describeTimings({
        execMs: 4300,
        timings: [
          { tool: "grep", target: "a", ms: 60 },
          { tool: "grep", target: "b", ms: 40 },
          { tool: "run", target: "powershell -File build.ps1", ms: 2100 },
          { tool: "run", target: "svn status", ms: 1700 },
          { tool: "read", target: "a.sql", ms: 3 },
        ],
      }),
    ).toBe("Akce trvaly 4,3 s: run 2× 3,8 s, grep 2× 0,1 s. Nejdéle: run powershell -File build.ps1 (2,1 s); run svn status (1,7 s)");
  });
});
