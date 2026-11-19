import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/engine/SessionData";
import { TurnEngine } from "../src/engine/TurnEngine";
import { NodeHost } from "../src/host/NodeHost";
import { parseReply } from "../src/protocol/parser";
import { buildAgentInstructions, buildInitialPrompt, DEFAULT_OPTIONS, ProjectContext } from "../src/protocol/prompt";
import {
  CallTools,
  callInput,
  callScriptTool,
  checkArgs,
  loadScriptTools,
  parseManifest,
  parseToolSuggestion,
  promptTools,
  resolveRunCommand,
  ScriptTool,
  signature,
  toolHash,
  ToolGate,
  ToolApproval,
} from "../src/tools/scripttools";

/** Python 3, kterým tu jdou pustit testovací nástroje (bez něj se testy se skriptem přeskočí). */
const PYTHON = ["python3", "python"].find((c) => {
  try {
    return /Python 3/.test(execFileSync(c, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return false;
  }
});
const withPython = PYTHON ? it : it.skip;

const where = { dir: "/x/db-object", file: "/x/db-object/tool.json", scope: "project" as const };

const MANIFEST = {
  name: "db-object",
  description: "Structure of a table: columns",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "object name, e.g. INVOICE_LINE", pattern: "^[A-Z_]+$" },
      schema: { type: "string", default: "NIP" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      details: { type: "boolean" },
      columns: { type: "array", items: { type: "string" } },
      mode: { enum: ["short", "full"] },
    },
    required: ["name"],
  },
  output: "JSON: columns [{name, type}]",
  run: "python run.py",
  readOnly: true,
  examples: [{ args: { name: "DUAL" } }],
};

const SCRIPT = [
  "import json, os, sys",
  "req = json.load(sys.stdin)",
  "a = req['args']",
  "if a.get('name') == 'FAIL':",
  "    print('table FAIL does not exist', file=sys.stderr); sys.exit(3)",
  "if a.get('name') == 'TEXT':",
  "    print('plain answer: žluťoučký kůň'); sys.exit(0)",
  "if a.get('name') == 'BIG':",
  "    print(json.dumps({'rows': [{'n': i, 'text': 'x' * 40} for i in range(2000)]})); sys.exit(0)",
  "if a.get('name') == 'SLOW':",
  "    import time; time.sleep(30)",
  "print(json.dumps({'name': a['name'], 'schema': a.get('schema'), 'tool': req['tool'], 'cwd_is_tool': os.getcwd() == os.environ['COPY_AGENT_TOOL_DIR'], 'workspace': req['workspace']}))",
].join("\n");

function writeTool(base: string, name: string, manifest: object, script = SCRIPT): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tool.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "run.py"), script);
  return dir;
}

describe("tool.json", () => {
  it("accepts a valid manifest and fills defaults", () => {
    const t = parseManifest(JSON.stringify(MANIFEST), "db-object", where);
    expect(t.errors).toEqual([]);
    expect(t).toMatchObject({ name: "db-object", readOnly: true, timeout: 30, maxChars: 20000, run: "python run.py" });
    expect(signature(t)).toBe('db-object(name: string, schema?: string = "NIP", limit?: integer, details?: boolean, columns?: string[], mode?: "short"|"full")');
  });

  it("reports everything that is wrong, so the model can fix it in one go", () => {
    const t = parseManifest(JSON.stringify({ name: "Other Name", inputSchema: { type: "object", properties: { a: {} }, required: ["b"] }, readOnly: "yes", examples: [{ args: { a: 1 } }, {}] }), "db-object", where);
    expect(t.errors.join("\n")).toMatch(/"name" must be lowercase/);
    expect(t.errors.join("\n")).toMatch(/"description" is required/);
    expect(t.errors.join("\n")).toMatch(/"run" is required/);
    expect(t.errors.join("\n")).toMatch(/"readOnly" must be true or false/);
    expect(t.errors.join("\n")).toMatch(/properties\.a" needs "type"/);
    expect(t.errors.join("\n")).toMatch(/required" names "b"/);
    expect(t.errors.join("\n")).toMatch(/examples\[1\] must be/);
    expect(parseManifest("{nope", "x", where).errors[0]).toMatch(/not valid JSON/);
    expect(parseManifest(JSON.stringify({ ...MANIFEST, name: "other" }), "db-object", where).errors[0]).toMatch(/same as the folder name/);
  });

  it("checks the examples against the schema", () => {
    const t = parseManifest(JSON.stringify({ ...MANIFEST, examples: [{ args: { name: "lower" } }] }), "db-object", where);
    expect(t.errors).toEqual(['examples[0]: "name" does not match the pattern ^[A-Z_]+$: "lower"']);
  });

  it("loads project and global tools; the project wins on the same name", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-ws-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-home-"));
    try {
      writeTool(path.join(ws, ".copy-agent", "tools"), "db-object", MANIFEST);
      writeTool(path.join(home, ".copy-agent", "tools"), "db-object", { ...MANIFEST, description: "global copy" });
      writeTool(path.join(home, ".copy-agent", "tools"), "svn-log", { ...MANIFEST, name: "svn-log", description: "Commits" });
      fs.mkdirSync(path.join(home, ".copy-agent", "tools", "no-manifest"));
      const tools = loadScriptTools(ws, home);
      expect(tools.map((t) => [t.name, t.scope, t.description])).toEqual([
        ["db-object", "project", "Structure of a table: columns"],
        ["svn-log", "global", "Commits"],
      ]);
      expect(promptTools(tools)[0]).toMatchObject({ signature: expect.stringContaining("db-object(name: string"), params: [{ name: "name", description: "object name, e.g. INVOICE_LINE" }] });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("arguments", () => {
  const tool = parseManifest(JSON.stringify(MANIFEST), "db-object", where);

  it("converts attribute text by the schema and adds defaults", () => {
    const { input, fromAttrs } = callInput({ tool: "db-object", name: "INVOICE", limit: "5", details: "true", columns: "ID, PRICE", mode: "full" });
    expect(checkArgs(tool.inputSchema, input, fromAttrs)).toEqual({ args: { name: "INVOICE", limit: 5, details: true, columns: ["ID", "PRICE"], mode: "full", schema: "NIP" }, errors: [] });
  });

  it("takes a JSON body (also fenced or HTML-escaped) and lets it override attributes", () => {
    expect(callInput({ tool: "x", name: "A" }, '{"name": "B", "columns": ["ID"]}').input).toEqual({ name: "B", columns: ["ID"] });
    expect(callInput({ tool: "x" }, '```json\n{"name": "C"}\n```').input).toEqual({ name: "C" });
    expect(callInput({ tool: "x" }, "{&quot;name&quot;: &quot;D&quot;}").input).toEqual({ name: "D" });
    expect(callInput({ tool: "x" }, "name=E").errors[0]).toMatch(/must be a JSON object/);
  });

  it("rejects wrong and unknown arguments with a precise reason", () => {
    const { input, fromAttrs } = callInput({ tool: "db-object", limit: "500", details: "maybe", mode: "medium", colour: "red" });
    expect(checkArgs(tool.inputSchema, input, fromAttrs).errors).toEqual([
      '"limit" must be at most 100, got 500',
      '"details" must be true or false, got string "maybe"',
      '"mode" must be one of "short", "full", got "medium"',
      'unknown argument "colour" (known: name, schema, limit, details, columns, mode)',
      'missing required argument "name" (object name, e.g. INVOICE_LINE)',
    ]);
    expect(checkArgs(tool.inputSchema, { name: 7 }).errors).toEqual(['"name" must be a string, got number 7']);
  });

  it("starts Python with the command that works on this computer", () => {
    expect(resolveRunCommand("python run.py --x", "py -3")).toBe("py -3 run.py --x");
    expect(resolveRunCommand("python3 run.py", "python")).toBe("python run.py");
    expect(resolveRunCommand("node run.js", "py -3")).toBe("node run.js");
    expect(resolveRunCommand("python run.py")).toBe("python run.py");
  });
});

describe("running a tool", () => {
  let base: string;
  let tool: ScriptTool;
  const opts = () => ({ workspace: base, roots: [base], python: PYTHON });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-run-"));
    const dir = writeTool(base, "db-object", MANIFEST);
    tool = parseManifest(fs.readFileSync(path.join(dir, "tool.json"), "utf8"), "db-object", { dir, file: path.join(dir, "tool.json"), scope: "project" });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  withPython("passes the arguments as JSON on stdin and returns the JSON response", async () => {
    const r = await callScriptTool(tool, { name: "INVOICE", schema: "NIP" }, opts());
    expect(r.status).toBe("ok");
    expect(r.json).toEqual({ name: "INVOICE", schema: "NIP", tool: "db-object", cwd_is_tool: true, workspace: base });
    expect(r.text).toBe(JSON.stringify(r.json));
  });

  withPython("returns plain text, errors from stderr and stops a tool that does not answer", async () => {
    expect(await callScriptTool(tool, { name: "TEXT" }, opts())).toMatchObject({ status: "ok", text: "plain answer: žluťoučký kůň", json: undefined });
    expect(await callScriptTool(tool, { name: "FAIL" }, opts())).toMatchObject({ status: "error", exit: 3, text: "table FAIL does not exist" });
    const slow = await callScriptTool({ ...tool, timeout: 1 }, { name: "SLOW" }, opts());
    expect(slow).toMatchObject({ status: "error", timedOut: true });
    expect(slow.text).toMatch(/did not answer within 1 s/);
  });

  it("the trust hash follows the content, not the data folder", () => {
    const before = toolHash(tool.dir);
    fs.mkdirSync(path.join(tool.dir, "data"));
    fs.writeFileSync(path.join(tool.dir, "data", "cache.json"), "{}");
    fs.mkdirSync(path.join(tool.dir, "__pycache__"));
    fs.writeFileSync(path.join(tool.dir, "__pycache__", "run.cpython-312.pyc"), "x");
    expect(toolHash(tool.dir)).toBe(before);
    fs.appendFileSync(path.join(tool.dir, "run.py"), "\n# changed\n");
    expect(toolHash(tool.dir)).not.toBe(before);
  });
});

describe("ToolGate", () => {
  const make = (readOnly: boolean, answer = true) => {
    const store = new Map<string, string>();
    const asked: ToolApproval[] = [];
    let content = "v1";
    const gate = new ToolGate(
      { get: (f) => store.get(f), set: (f, h) => void store.set(f, h) },
      async (req) => {
        asked.push(req);
        await new Promise((r) => setTimeout(r, 5));
        return answer;
      },
      () => content,
    );
    const tool = { ...parseManifest(JSON.stringify({ ...MANIFEST, readOnly }), "db-object", where) };
    return { gate, tool, asked, store, change: (c: string) => (content = c) };
  };

  it("asks once for a new read-only tool, then trusts it until its content changes", async () => {
    const g = make(true);
    expect(await Promise.all([g.gate.allow(g.tool, {}), g.gate.allow(g.tool, {}), g.gate.allow(g.tool, {})])).toEqual([true, true, true]);
    expect(g.asked.map((a) => a.trust)).toEqual(["new"]);
    expect(await g.gate.allow(g.tool, {})).toBe(true);
    expect(g.asked).toHaveLength(1);
    g.change("v2");
    expect(g.gate.status(g.tool)).toBe("changed");
    expect(await g.gate.allow(g.tool, {})).toBe(true);
    expect(g.asked.map((a) => a.trust)).toEqual(["new", "changed"]);
  });

  it("asks before every call of a tool that can change data, and remembers nothing when declined", async () => {
    const g = make(false);
    await g.gate.allow(g.tool, { name: "A" });
    await g.gate.allow(g.tool, { name: "B" });
    expect(g.asked.map((a) => [a.trust, a.writes, a.args.name])).toEqual([
      ["new", true, "A"],
      ["ok", true, "B"],
    ]);
    const no = make(true, false);
    expect(await no.gate.allow(no.tool, {})).toBe(false);
    expect(no.store.size).toBe(0);
  });
});

describe("<call> in the protocol", () => {
  it("parses the attribute form, the JSON body form and an unclosed tag", () => {
    const p = parseReply('<copy turn="1">\n<call tool="db-object" name="A"/>\n<call tool="db-object">\n{"name": "B", "note": "a < b"}\n</call>\n<call tool="db-object" name="C">\n<done>x</done>\n</copy>');
    expect(p.errors).toEqual([]);
    expect(p.actions.map((a) => [a.tool, a.attrs.name, a.body])).toEqual([
      ["call", "A", undefined],
      ["call", undefined, '{"name": "B", "note": "a < b"}'],
      ["call", "C", undefined],
      ["done", undefined, "x"],
    ]);
  });

  it("treats a call cut off in its body as a truncated action", () => {
    const p = parseReply('<copy turn="1">\n<call tool="db-object">\n{"name": "B"');
    expect(p.truncatedAction).toMatchObject({ tool: "call" });
    expect(p.actions).toEqual([]);
  });

  it("is described in the Copilot instructions and listed in the task", () => {
    const text = buildAgentInstructions();
    expect(text).toContain('<call tool="name" arg="…"/> or <call tool="name">{JSON arguments}</call>');
    expect(text.length).toBeLessThanOrEqual(8000);
    const tool = parseManifest(JSON.stringify(MANIFEST), "db-object", where);
    const ctx: ProjectContext = { workspaceName: "demo", tree: "a.txt", tools: promptTools([tool]) };
    const prompt = buildInitialPrompt("s1", "task", ctx, DEFAULT_OPTIONS);
    expect(prompt).toContain("## Tools (call them with <call>; you get only the response, never the code)");
    expect(prompt).toContain('- db-object(name: string, schema?: string = "NIP", limit?: integer, details?: boolean, columns?: string[], mode?: "short"|"full") → JSON: columns [{name, type}]: Structure of a table: columns');
    expect(prompt).toContain("    name: object name, e.g. INVOICE_LINE");
    const writer = parseManifest(JSON.stringify({ ...MANIFEST, readOnly: false }), "db-object", where);
    expect(buildInitialPrompt("s1", "task", { ...ctx, tools: promptTools([writer]) }, DEFAULT_OPTIONS)).toContain("(changes data: the user confirms each call)");
  });
});

describe("<call> in a turn", () => {
  let dir: string;
  let engine: TurnEngine;
  let tools: CallTools;
  const calls: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tools-engine-"));
    const home = path.join(dir, "home-not-used");
    writeTool(path.join(dir, ".copy-agent", "tools"), "db-object", MANIFEST);
    const store = new Map<string, string>();
    calls.length = 0;
    tools = {
      list: () => loadScriptTools(dir, home),
      gate: new ToolGate({ get: (f) => store.get(f), set: (f, h) => void store.set(f, h) }, async () => true),
      python: async () => PYTHON,
      onCall: (rec) => calls.push(`${rec.source}:${rec.tool}:${rec.status}`),
    };
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", tools, runtime: async () => ({ platform: "linux" }) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists the tools in the first prompt", async () => {
    const ctx = await engine.gatherContext(undefined, undefined, "task");
    expect(ctx.tools?.map((t) => t.name)).toEqual(["db-object"]);
  });

  withPython("returns the response, rejects bad arguments without running and names unknown tools", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<call tool="db-object" name="INVOICE"/>\n<call tool="db-object" limit="x"/>\n<call tool="nope"/>\n<call tool="db-object" name="FAIL"/>\n</copy>'), 100);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") return;
    const [ok, bad, unknown, failed] = step.record.results;
    expect(ok).toMatchObject({ tool: "call", status: "ok", attrs: { tool: "db-object", name: "INVOICE", schema: "NIP" } });
    expect(JSON.parse(ok.output!)).toMatchObject({ name: "INVOICE", schema: "NIP" });
    expect(bad).toMatchObject({ status: "error", meta: { rejected: "arguments" } });
    expect(bad.output).toContain('"limit" must be a number, got string "x"');
    expect(bad.output).toContain("Signature: db-object(name: string");
    expect(unknown.output).toMatch(/Unknown tool "nope"\. Available: db-object\(/);
    expect(failed).toMatchObject({ status: "error", meta: { exit: 3 }, output: "table FAIL does not exist" });
    expect(step.prompt).toContain('<result of="call" tool="db-object" name="INVOICE" schema="NIP" status="ok"');
    expect(calls).toEqual(["model:db-object:ok", "model:db-object:error"]);
  });

  withPython("saves a long response to a file and gives the model its start", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<call tool="db-object" name="BIG"/>\n</copy>'), 100);
    if (step.kind !== "next") throw new Error(step.kind);
    const r = step.record.results[0];
    expect(r.meta).toMatchObject({ truncated: "true" });
    expect(r.output!.length).toBeLessThan(21000);
    expect(r.output).toMatch(/The complete response is in \.copy-agent\/out\/call-db-object-1-0\.json \(\d+ lines\)/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".copy-agent/out/call-db-object-1-0.json"), "utf8")).rows).toHaveLength(2000);
  });

  withPython("tries a tool written in the block on its examples", async () => {
    const session = createSession("task");
    const manifest = JSON.stringify({ ...MANIFEST, name: "svn-log", examples: [{ args: { name: "DUAL" } }, { args: { name: "FAIL" } }] });
    const reply = `<copy turn="1">\n<write path=".copy-agent/tools/svn-log/tool.json">\n${manifest}\n</write>\n<write path=".copy-agent/tools/svn-log/run.py">\n${SCRIPT}\n</write>\n<write path=".copy-agent/tools/broken/tool.json">\n{"name": "broken"}\n</write>\n</copy>`;
    const step = await engine.execute(session, engine.parse(reply), 100);
    if (step.kind !== "next") throw new Error(step.kind);
    const tried = step.record.results.filter((r) => r.tool === "call");
    expect(tried.map((r) => [r.attrs.tool, r.attrs.example ?? r.attrs.check, r.status])).toEqual([
      ["broken", "after change", "error"],
      ["svn-log", "1", "ok"],
      ["svn-log", "2", "error"],
    ]);
    expect(tried[0].output).toMatch(/"description" is required/);
    expect(calls).toEqual(["example:svn-log:ok", "example:svn-log:error"]);
  });
});

describe("<suggest kind=\"tool\">", () => {
  it("splits the body into tool.json and the other files", () => {
    const r = parseToolSuggestion('{"name": "x"}\n--- run.py ---\nimport sys\nprint(1)\n--- lib/util.py ---\nX = 1\n');
    expect(r).toEqual({ manifest: '{"name": "x"}\n', files: { "tool.json": '{"name": "x"}\n', "run.py": "import sys\nprint(1)\n", "lib/util.py": "X = 1\n" } });
    expect(parseToolSuggestion("--- run.py ---\nprint(1)")).toEqual({ error: "the suggestion has no tool.json" });
    expect(parseToolSuggestion('{}\n--- ../evil.py ---\nx')).toEqual({ error: "file names must stay inside the tool folder" });
  });
});
