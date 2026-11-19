import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Host } from "../host/Host";
import { terminate, workspaceEnv } from "../host/spawn";
import type { PromptTool } from "../protocol/prompt";
import { STATE_DIR } from "../protocol/roots";
import { decodeEntities, sanitizeSecrets } from "../protocol/text";

/**
 * Nástroje: funkce se specifikací, které model volá akcí <call>. Nástroj je složka s `tool.json`
 * (název, popis, JSON Schema argumentů, příkaz) a skriptem. Model zná jen podpis a popis; pošle
 * argumenty, Copy Agent je ověří, spustí skript (argumenty jako JSON na stdin) a vrátí jeho odpověď
 * (stdout). Skript model nikdy nevidí. Tvar `inputSchema` je stejný jako u nástrojů MCP.
 *
 *  - <workspace>/.copy-agent/tools/<název>/tool.json   projektový (má přednost)
 *  - ~/.copy-agent/tools/<název>/tool.json             globální
 *
 * Nic tady nesahá na `vscode`: schvalování dodává volající přes `ToolGate`.
 */

export const TOOLS_DIR = "tools";
export const TOOL_FILE = "tool.json";
/** Podsložka nástroje pro jeho vlastní data a mezipaměť: nepočítá se do obsahu, kterému uživatel věří. */
export const TOOL_DATA_DIR = "data";
export const DEFAULT_TIMEOUT_S = 30;
export const DEFAULT_MAX_CHARS = 20_000;
const MAX_STREAM = 5_000_000;
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

export type JsonType = (typeof TYPES)[number];

export interface PropSchema {
  type?: JsonType;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: PropSchema;
}

export interface InputSchema {
  type: "object";
  properties: Record<string, PropSchema>;
  required: string[];
  additionalProperties: boolean;
}

export interface ToolExample {
  args: Record<string, unknown>;
  note?: string;
}

export interface ScriptTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  /** popis odpovědi pro model (co v ní je) */
  output?: string;
  /** příkaz spouštěný ve složce nástroje, např. `python run.py` */
  run: string;
  /** nástroj jen čte: běží bez dotazu (když mu uživatel věří) a smí souběžně s ostatními čtecími akcemi */
  readOnly: boolean;
  /** sekundy */
  timeout: number;
  /** delší odpověď se uloží do souboru a model dostane začátek a cestu */
  maxChars: number;
  examples: ToolExample[];
  dir: string;
  /** absolutní cesta k tool.json */
  file: string;
  /** builtin = součást rozšíření, běží v jeho procesu (viz index/builtin.ts) */
  scope: "project" | "global" | "builtin";
  /** vestavěný nástroj: funkce místo skriptu; nic se nespouští a neschvaluje */
  builtin?: (args: Record<string, unknown>, ctx: { host: Host }) => Promise<string>;
  /** chyby v tool.json; takový nástroj se modelu nenabízí ani nespustí */
  errors: string[];
}

// ---------------------------------------------------------------------------------------------
// tool.json

/** Rozebere a ověří tool.json. Vrací nástroj vždy (i s chybami), aby panel mohl ukázat, co je špatně. */
export function parseManifest(text: string, folder: string, where: { dir: string; file: string; scope: "project" | "global" }): ScriptTool {
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(text.replace(/^﻿/, ""));
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    else errors.push("tool.json must be a JSON object");
  } catch (e) {
    errors.push(`tool.json is not valid JSON: ${(e as Error).message}`);
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : folder;
  if (!NAME_RE.test(name)) errors.push(`"name" must be lowercase letters, digits and "-" starting with a letter (e.g. "db-object"), got ${JSON.stringify(raw.name ?? folder)}`);
  else if (name !== folder) errors.push(`"name" (${name}) must be the same as the folder name (${folder})`);
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) errors.push('"description" is required: one line saying what the tool does and returns');
  const run = typeof raw.run === "string" ? raw.run.trim() : "";
  if (!run) errors.push('"run" is required: the command that starts the tool inside its folder, e.g. "python run.py"');
  if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") errors.push('"readOnly" must be true or false');
  const num = (key: string, def: number, min: number, max: number): number => {
    const v = raw[key];
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`"${key}" must be a number`);
      return def;
    }
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  const inputSchema = parseInputSchema(raw.inputSchema, errors);
  const examples: ToolExample[] = [];
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) errors.push('"examples" must be a list of {"args": {…}}');
    else
      raw.examples.forEach((ex: unknown, i: number) => {
        const e = ex as { args?: unknown; note?: unknown };
        if (!e || typeof e !== "object" || !e.args || typeof e.args !== "object" || Array.isArray(e.args)) {
          errors.push(`examples[${i}] must be {"args": {…}}`);
          return;
        }
        const checked = checkArgs(inputSchema, e.args as Record<string, unknown>);
        for (const err of checked.errors) errors.push(`examples[${i}]: ${err}`);
        examples.push({ args: e.args as Record<string, unknown>, note: typeof e.note === "string" ? e.note : undefined });
      });
  }
  return {
    name: NAME_RE.test(name) ? name : folder,
    description,
    inputSchema,
    output: typeof raw.output === "string" && raw.output.trim() ? raw.output.trim() : undefined,
    run,
    readOnly: raw.readOnly === true,
    timeout: num("timeout", DEFAULT_TIMEOUT_S, 1, 600),
    maxChars: num("maxChars", DEFAULT_MAX_CHARS, 1000, 200_000),
    examples,
    ...where,
    errors,
  };
}

function parseInputSchema(v: unknown, errors: string[]): InputSchema {
  const schema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  if (v === undefined) return schema;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errors.push('"inputSchema" must be a JSON Schema object: {"type": "object", "properties": {…}, "required": […]}');
    return schema;
  }
  const s = v as Record<string, unknown>;
  if (s.type !== undefined && s.type !== "object") errors.push('"inputSchema.type" must be "object"');
  if (s.additionalProperties === true) schema.additionalProperties = true;
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) errors.push('"inputSchema.properties" must be an object');
    else for (const [k, p] of Object.entries(s.properties as Record<string, unknown>)) {
      const prop = parseProp(p, `inputSchema.properties.${k}`, errors);
      if (prop) schema.properties[k] = prop;
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")) errors.push('"inputSchema.required" must be a list of argument names');
    else
      for (const r of s.required as string[]) {
        if (!schema.properties[r]) errors.push(`"inputSchema.required" names "${r}", which is not in "properties"`);
        else schema.required.push(r);
      }
  }
  return schema;
}

function parseProp(v: unknown, at: string, errors: string[]): PropSchema | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errors.push(`"${at}" must be an object like {"type": "string", "description": "…"}`);
    return undefined;
  }
  const p = v as Record<string, unknown>;
  const out: PropSchema = {};
  if (p.type !== undefined) {
    if (typeof p.type !== "string" || !(TYPES as readonly string[]).includes(p.type)) errors.push(`"${at}.type" must be one of ${TYPES.join(", ")}`);
    else out.type = p.type as JsonType;
  }
  if (p.enum !== undefined) {
    if (!Array.isArray(p.enum) || !p.enum.length) errors.push(`"${at}.enum" must be a non-empty list`);
    else out.enum = p.enum;
  }
  if (!out.type && !out.enum) errors.push(`"${at}" needs "type" (or "enum")`);
  if (typeof p.description === "string" && p.description.trim()) out.description = p.description.trim();
  if (p.default !== undefined) out.default = p.default;
  if (p.pattern !== undefined) {
    try {
      new RegExp(String(p.pattern));
      out.pattern = String(p.pattern);
    } catch {
      errors.push(`"${at}.pattern" is not a valid regular expression`);
    }
  }
  if (typeof p.minimum === "number") out.minimum = p.minimum;
  if (typeof p.maximum === "number") out.maximum = p.maximum;
  if (p.items !== undefined) out.items = parseProp(p.items, `${at}.items`, errors);
  return out;
}

/** Nástroje z projektu a z ~/.copy-agent; při shodě jména vyhrává projekt (jako u skillů). */
export function loadScriptTools(workspaceRoot: string, home: string = os.homedir()): ScriptTool[] {
  const sources: { dir: string; scope: "project" | "global" }[] = [
    { dir: path.join(workspaceRoot, STATE_DIR, TOOLS_DIR), scope: "project" },
    { dir: path.join(home, STATE_DIR, TOOLS_DIR), scope: "global" },
  ];
  const seen = new Set<string>();
  const out: ScriptTool[] = [];
  const done = new Set<string>();
  for (const src of sources) {
    const key = path.resolve(src.dir);
    if (done.has(key)) continue;
    done.add(key);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(src.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = path.join(src.dir, e.name);
      const file = path.join(dir, TOOL_FILE);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const tool = parseManifest(text, e.name, { dir, file, scope: src.scope });
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  }
  return out;
}

/** Složka nástroje, kterou měnila cesta zapsaná modelem (`.copy-agent/tools/<název>/…`, i `~/.copy-agent/…`). */
export function toolNameOfPath(rel: string): string | undefined {
  return /(?:^|\/)\.copy-agent\/tools\/([a-z0-9][a-z0-9-]*)\//i.exec(rel.replace(/\\/g, "/"))?.[1]?.toLowerCase();
}

const HASH_SKIP = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv", TOOL_DATA_DIR]);

/**
 * Otisk obsahu složky nástroje (cesty a obsah souborů). Důvěra uživatele platí pro tenhle otisk:
 * po změně kódu nebo tool.json se Copy Agent zeptá znovu. Složka `data/` a .pyc se nepočítají.
 */
export function toolHash(dir: string): string {
  const h = createHash("sha256");
  let files = 0;
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (HASH_SKIP.has(e.name) && (e.name !== TOOL_DATA_DIR || !rel) && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 4) walk(r, depth + 1);
        continue;
      }
      if (!e.isFile() || /\.py[co]$/i.test(e.name) || ++files > 500) continue;
      const abs = path.join(dir, r);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      h.update(`${r}\0${size}\0`);
      if (size <= 2_000_000) h.update(fs.readFileSync(abs));
      h.update("\0");
    }
  };
  walk("", 0);
  return h.digest("hex");
}

/** Platné nástroje v podobě pro prompt modelu. */
export function promptTools(list: ScriptTool[]): PromptTool[] {
  return list
    .filter((t) => !t.errors.length)
    .map((t) => ({
      name: t.name,
      signature: signature(t),
      description: t.description,
      output: t.output,
      readOnly: t.readOnly,
      params: Object.entries(t.inputSchema.properties)
        .filter(([, p]) => p.description)
        .map(([name, p]) => ({ name, description: p.description! })),
    }));
}

// ---------------------------------------------------------------------------------------------
// Argumenty

/** Podpis pro model: `db-object(name: string, schema?: string = "NIP")`. */
export function signature(t: ScriptTool): string {
  const req = new Set(t.inputSchema.required);
  const parts = Object.entries(t.inputSchema.properties).map(([k, p]) => `${k}${req.has(k) ? "" : "?"}: ${typeLabel(p)}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ""}`);
  return `${t.name}(${parts.join(", ")})`;
}

function typeLabel(p: PropSchema): string {
  if (p.enum) return p.enum.map((e) => JSON.stringify(e)).join("|");
  if (p.type === "array") return `${p.items ? typeLabel(p.items) : "any"}[]`;
  return p.type ?? "any";
}

function coerce(p: PropSchema, s: string): unknown {
  const t = s.trim();
  if (p.enum && !p.type) return p.enum.find((e) => String(e) === t) ?? s;
  switch (p.type) {
    case "number":
    case "integer":
      return t !== "" && Number.isFinite(Number(t)) ? Number(t) : s;
    case "boolean":
      return /^(true|1|yes|ano)$/i.test(t) ? true : /^(false|0|no|ne)$/i.test(t) ? false : s;
    case "array":
      try {
        const v: unknown = JSON.parse(t);
        if (Array.isArray(v)) return v;
      } catch {
        /* čárkami oddělený seznam */
      }
      return t === "" ? [] : t.split(",").map((x) => (p.items ? coerce(p.items, x.trim()) : x.trim()));
    case "object":
      try {
        return JSON.parse(t);
      } catch {
        return s;
      }
    default:
      return s;
  }
}

function typeError(p: PropSchema, v: unknown, label: string): string | null {
  const want = p.type;
  const got = Array.isArray(v) ? "a list" : v === null ? "null" : typeof v === "object" ? "an object" : `${typeof v} ${JSON.stringify(v)}`;
  if (want === "string" && typeof v !== "string") return `"${label}" must be a string, got ${got}`;
  if ((want === "number" || want === "integer") && (typeof v !== "number" || !Number.isFinite(v))) return `"${label}" must be a number, got ${got}`;
  if (want === "integer" && !Number.isInteger(v)) return `"${label}" must be a whole number, got ${got}`;
  if (want === "boolean" && typeof v !== "boolean") return `"${label}" must be true or false, got ${got}`;
  if (want === "array" && !Array.isArray(v)) return `"${label}" must be a list, got ${got}`;
  if (want === "object" && (!v || typeof v !== "object" || Array.isArray(v))) return `"${label}" must be an object, got ${got}`;
  if (p.enum && !p.enum.some((e) => e === v)) return `"${label}" must be one of ${p.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(v)}`;
  if (p.pattern && typeof v === "string" && !new RegExp(p.pattern).test(v)) return `"${label}" does not match the pattern ${p.pattern}: ${JSON.stringify(v)}`;
  if (typeof v === "number" && p.minimum !== undefined && v < p.minimum) return `"${label}" must be at least ${p.minimum}, got ${v}`;
  if (typeof v === "number" && p.maximum !== undefined && v > p.maximum) return `"${label}" must be at most ${p.maximum}, got ${v}`;
  if (Array.isArray(v) && p.items) {
    for (let i = 0; i < v.length; i++) {
      const e = typeError(p.items, v[i], `${label}[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

/**
 * Ověří argumenty podle schématu a doplní výchozí hodnoty. Hodnoty z atributů (`fromAttrs`) jsou
 * texty: převedou se na číslo, true/false nebo seznam podle schématu.
 */
export function checkArgs(schema: InputSchema, input: Record<string, unknown>, fromAttrs: Set<string> = new Set()): { args: Record<string, unknown>; errors: string[] } {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [k, raw] of Object.entries(input)) {
    const p = schema.properties[k];
    if (!p) {
      if (schema.additionalProperties) args[k] = raw;
      else errors.push(`unknown argument "${k}"${Object.keys(schema.properties).length ? ` (known: ${Object.keys(schema.properties).join(", ")})` : " (this tool takes no arguments)"}`);
      continue;
    }
    const v = fromAttrs.has(k) && typeof raw === "string" ? coerce(p, raw) : raw;
    const err = typeError(p, v, k);
    if (err) errors.push(err);
    else args[k] = v;
  }
  for (const [k, p] of Object.entries(schema.properties)) {
    if (k in input) continue;
    if (p.default !== undefined) args[k] = p.default;
    else if (schema.required.includes(k)) errors.push(`missing required argument "${k}"${p.description ? ` (${p.description})` : ""}`);
  }
  return { args, errors };
}

/**
 * Argumenty z akce <call>: atributy (kromě `tool`) a volitelně JSON objekt v těle. Tělo zabalené do
 * ohrazení nebo HTML-escapované se rozbalí. Vrací chyby, když tělo není JSON objekt.
 */
export function callInput(attrs: Record<string, string>, body?: string): { input: Record<string, unknown>; fromAttrs: Set<string>; errors: string[] } {
  const input: Record<string, unknown> = {};
  const fromAttrs = new Set<string>();
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "tool") continue;
    input[k] = v;
    fromAttrs.add(k);
  }
  const text = (body ?? "").trim();
  if (!text) return { input, fromAttrs, errors: [] };
  let src = text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
  const fence = /^(`{3,}|~{3,})[\w-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/.exec(src);
  if (fence) src = fence[2].trim();
  let parsed: unknown;
  for (const candidate of [src, decodeEntities(src)]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      /* zkusí se dekódovaná podoba */
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { input, fromAttrs, errors: ["the body of <call> must be a JSON object with the arguments, e.g. {\"name\": \"X\"}"] };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    input[k] = v;
    fromAttrs.delete(k);
  }
  return { input, fromAttrs, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// Spuštění

/** `python run.py` → příkaz, kterým tu Python opravdu jde spustit (`py -3`, `python3`). */
export function resolveRunCommand(run: string, python?: string): string {
  if (!python) return run;
  return run.replace(/^(?:python3?|py(?:\s+-3)?)(?=\s|$)/, python);
}

export interface CallResponse {
  status: "ok" | "error";
  /** odpověď pro model: JSON zhuštěný na jeden řádek, nebo text; u chyby její popis */
  text: string;
  /** rozebraná odpověď, když byla JSON */
  json?: unknown;
  durationMs: number;
  exit: number | null;
  timedOut: boolean;
  interrupted: boolean;
}

export interface CallOptions {
  workspace: string;
  roots: string[];
  python?: string;
  signal?: AbortSignal;
}

/**
 * Spustí nástroj: příkaz `run` ve složce nástroje, na stdin JSON {"args", "tool", "workspace", "roots"}.
 * Úspěch = návratový kód 0, odpověď je stdout (JSON nebo text). Jinak chyba s textem ze stderr.
 */
export function callScriptTool(tool: ScriptTool, args: Record<string, unknown>, opts: CallOptions): Promise<CallResponse> {
  const started = Date.now();
  return new Promise<CallResponse>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ status: "error", text: "Not executed: the user interrupted this turn.", durationMs: 0, exit: null, timedOut: false, interrupted: true });
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      COPY_AGENT_WORKSPACE: opts.workspace,
      COPY_AGENT_TOOL_DIR: tool.dir,
      ...workspaceEnv(opts.roots),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let interrupted = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      interrupted = true;
      terminate(child);
    };
    const finish = (exit: number | null, startError?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - started;
      const stdout = Buffer.concat(out).toString("utf8").replace(/^﻿/, "").trim();
      const stderr = Buffer.concat(err).toString("utf8").replace(/^﻿/, "").trim();
      const base = { durationMs, exit, timedOut, interrupted };
      if (startError) return resolve({ ...base, status: "error", text: `The tool could not be started (${tool.run}): ${startError}` });
      if (interrupted) return resolve({ ...base, status: "error", text: "Interrupted by the user; the tool was stopped." });
      if (timedOut) return resolve({ ...base, status: "error", text: `The tool did not answer within ${tool.timeout} s and was stopped.${stderr ? `\n${clip(stderr)}` : ""}` });
      if (exit !== 0) return resolve({ ...base, status: "error", text: sanitizeSecrets(clip(stderr || stdout) || `The tool failed with exit code ${exit} and printed nothing.`) });
      let json: unknown;
      if (/^[[{"]/.test(stdout)) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = undefined;
        }
      }
      resolve({ ...base, status: "ok", text: sanitizeSecrets(json !== undefined ? JSON.stringify(json) : stdout), json });
    };
    try {
      child = spawn(resolveRunCommand(tool.run, opts.python), { cwd: tool.dir, shell: true, env, windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      finish(null, (e as Error).message);
      return;
    }
    const collect = (into: Buffer[]) => (d: Buffer) => {
      if (size > MAX_STREAM) return;
      size += d.length;
      into.push(d);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, tool.timeout * 1000);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // nástroj, který stdin nečte, ho může zavřít dřív: to není chyba
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify({ args, tool: tool.name, workspace: opts.workspace, roots: opts.roots }) + "\n");
  });
}

function clip(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/**
 * Dlouhá odpověď: model dostane začátek (celé řádky) a cestu k souboru s celou odpovědí. JSON se pro
 * soubor rozepíše na řádky, aby šel číst po částech přes <read lines="A-B">.
 */
export function splitLongResponse(r: CallResponse, maxChars: number): { head: string; full: string; lines: number } | null {
  if (r.text.length <= maxChars) return null;
  const full = r.json !== undefined ? sanitizeSecrets(JSON.stringify(r.json, null, 1)) : r.text;
  let head = full.slice(0, maxChars);
  const cut = head.lastIndexOf("\n");
  if (cut > maxChars / 2) head = head.slice(0, cut);
  return { head, full, lines: full.split("\n").length };
}

// ---------------------------------------------------------------------------------------------
// Důvěra a schvalování

/** Kde si Copy Agent pamatuje, kterému obsahu nástroje uživatel věří (cesta tool.json → otisk). */
export interface TrustStore {
  get(file: string): string | undefined;
  set(file: string, hash: string): void | PromiseLike<void>;
}

export interface ToolApproval {
  tool: ScriptTool;
  args: Record<string, unknown>;
  /** new = nástroj se ještě nespouštěl, changed = obsah se od povolení změnil, ok = věří se mu */
  trust: "new" | "changed" | "ok";
  /** nástroj může měnit data (nemá readOnly: true): schvaluje se každé volání */
  writes: boolean;
}

/**
 * Rozhoduje, jestli se volání smí spustit. Nástroji, kterému uživatel uvěřil, se věří, dokud se
 * nezmění obsah jeho složky (globální i projektový: model smí psát i do ~/.copy-agent). Nástroj,
 * který může měnit data, se schvaluje při každém volání. Souběžná volání téhož nového nástroje
 * čekají na jedno rozhodnutí.
 */
export class ToolGate {
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly store: TrustStore,
    private readonly ask: (req: ToolApproval) => Promise<boolean>,
    private readonly hash: (dir: string) => string = toolHash,
  ) {}

  status(tool: ScriptTool): "new" | "changed" | "ok" {
    const known = this.store.get(tool.file);
    if (!known) return "new";
    return known === this.hash(tool.dir) ? "ok" : "changed";
  }

  async allow(tool: ScriptTool, args: Record<string, unknown>): Promise<boolean> {
    const hash = this.hash(tool.dir);
    const known = this.store.get(tool.file);
    const trust: ToolApproval["trust"] = !known ? "new" : known === hash ? "ok" : "changed";
    const writes = !tool.readOnly;
    if (trust === "ok" && !writes) return true;
    if (!writes) {
      // čtecí nástroj: rozhoduje se jen o důvěře v obsah, jednou pro všechna souběžná volání
      const key = `${tool.file}\0${hash}`;
      let p = this.pending.get(key);
      if (!p) {
        p = this.ask({ tool, args, trust, writes }).then(async (ok) => {
          if (ok) await this.store.set(tool.file, hash);
          return ok;
        });
        this.pending.set(key, p);
        void p.then(
          () => this.pending.delete(key),
          () => this.pending.delete(key),
        );
      }
      return p;
    }
    const ok = await this.ask({ tool, args, trust, writes });
    if (ok && trust !== "ok") await this.store.set(tool.file, hash);
    return ok;
  }
}

/** Co nástroje potřebují od prostředí: seznam, schvalování, příkaz Pythonu, záznam volání. */
export interface CallTools {
  list(): ScriptTool[];
  gate: Pick<ToolGate, "allow">;
  python?(): Promise<string | undefined>;
  onCall?(rec: CallRecord): void;
}

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "error" | "denied";
  ms: number;
  at: string;
  /** začátek odpovědi nebo chyby */
  preview: string;
  source: "model" | "example" | "user";
}

/** Jedno volání od začátku do konce: ověření argumentů, schválení, spuštění, záznam. */
export async function invokeTool(
  tools: CallTools,
  tool: ScriptTool,
  input: Record<string, unknown>,
  fromAttrs: Set<string>,
  ctx: { workspace: string; roots: string[]; signal?: AbortSignal; source: CallRecord["source"]; host?: Host },
): Promise<{ status: "ok" | "error" | "denied"; args: Record<string, unknown>; text: string; response?: CallResponse; rejected?: string[] }> {
  const { args, errors } = checkArgs(tool.inputSchema, input, fromAttrs);
  if (errors.length) return { status: "error", args, text: "", rejected: errors };
  const record = (status: CallRecord["status"], ms: number, preview: string) =>
    tools.onCall?.({ tool: tool.name, args, status, ms, at: new Date().toISOString(), preview: preview.slice(0, 600), source: ctx.source });
  if (tool.builtin) {
    // vestavěný nástroj: běží v procesu rozšíření, jen čte, neschvaluje se
    const started = Date.now();
    let response: CallResponse;
    try {
      if (!ctx.host) throw new Error("built-in tools need the workspace host");
      const limit = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${tool.timeout} s`)), tool.timeout * 1000).unref?.());
      const text = await Promise.race([tool.builtin(args, { host: ctx.host }), limit]);
      response = { status: "ok", text, durationMs: Date.now() - started, exit: 0, timedOut: false, interrupted: false };
    } catch (e) {
      response = { status: "error", text: (e as Error).message, durationMs: Date.now() - started, exit: 1, timedOut: false, interrupted: false };
    }
    record(response.status, response.durationMs, response.text);
    return { status: response.status, args, text: response.text, response };
  }
  if (!(await tools.gate.allow(tool, args))) {
    record("denied", 0, "");
    return { status: "denied", args, text: "The user declined to run this tool." };
  }
  const response = await callScriptTool(tool, args, { workspace: ctx.workspace, roots: ctx.roots, python: await tools.python?.(), signal: ctx.signal });
  record(response.status, response.durationMs, response.text);
  return { status: response.status, args, text: response.text, response };
}

// ---------------------------------------------------------------------------------------------
// Návrh nástroje (<suggest kind="tool">)

/**
 * Tělo návrhu nástroje: obsah tool.json, pak pro každý další soubor řádek `--- run.py ---` a jeho
 * obsah. Vrací soubory k uložení, nebo chybu.
 */
export function parseToolSuggestion(body: string): { files: Record<string, string>; manifest: string } | { error: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const files: Record<string, string> = {};
  let current = TOOL_FILE;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) files[current] = text + "\n";
    buf = [];
  };
  for (const l of lines) {
    const m = /^-{3,}\s*([\w.-]+(?:\/[\w.-]+)*)\s*-{3,}\s*$/.exec(l);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    buf.push(l);
  }
  flush();
  const manifest = files[TOOL_FILE];
  if (!manifest) return { error: "the suggestion has no tool.json" };
  if (Object.keys(files).some((f) => f.split("/").includes("..") || path.isAbsolute(f))) return { error: "file names must stay inside the tool folder" };
  return { files, manifest };
}

/** Uloží soubory nástroje do `<base>/<název>/`; vrátí složku. */
export function saveToolFiles(base: string, name: string, files: Record<string, string>): string {
  const dir = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

/** Složka nástrojů pro projekt nebo globálně. */
export function toolsBase(workspaceRoot: string, global: boolean, home: string = os.homedir()): string {
  return global ? path.join(home, STATE_DIR, TOOLS_DIR) : path.join(workspaceRoot, STATE_DIR, TOOLS_DIR);
}
