import type { ChangeNote } from "../review/changeset";
import { Host } from "../host/Host";
import { applyHunks, parseHunks } from "../protocol/edit";
import { STATE_DIR } from "../protocol/roots";
import { Action, ActionResult, READ_ONLY_TOOLS, SILENT_TOOLS } from "../protocol/schema";
import { applySection } from "../protocol/section";
import { OK_RUN_OUTPUT_MAX } from "../protocol/text";
import { isProtectedPath } from "../safety/Policy";
import { BundleOptions, toolBundle } from "./bundle";
import { checkWrittenFiles, renderIssues } from "./check";
import { toolDiagnostics } from "./diagnostics";
import { describeEncodingEn, isPlainUtf8Lf } from "./encoding";
import { toolGlob, toolLs, toolRead } from "./fs";
import { toolGrep } from "./grep";
import { toolRun } from "./run";
import { takeScreenshot } from "./screenshot";
import { CallTools, callInput, invokeTool, ScriptTool, signature, splitLongResponse, toolNameOfPath } from "./scripttools";

/** Napojení na review změn (ve VS Code); headless běh ho nepotřebuje. */
export interface ChangeListener {
  onWillChange(path: string, kind: "create" | "modify", baseline: string, turn: number): void;
  onWillDelete(path: string, content: string, turn: number): void;
  /** volitelné schválení před zápisem; undefined = vždy povoleno */
  approve?(path: string, before: string, after: string): Promise<boolean>;
  /** model popsal změnu, kterou právě udělal (<change>): popis patří k souboru a znění před akcí a po ní */
  onNote?(note: ChangeNote): void;
}

/** Skill, jehož pokyny si model může vyžádat akcí <skill>. */
export interface SkillInfo {
  name: string;
  body?: string;
}

/** Poslední změna souboru v bloku: k ní se váže následující <change>. */
interface LastChange {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string;
  after: string;
}

export interface SuggestionDraft {
  kind: string;
  scope: "project" | "global";
  title: string;
  body: string;
  update?: string;
  lang?: string;
  file?: string;
}

export interface ChangedFile {
  path: string;
  kind: "create" | "modify" | "delete" | "move";
  /** počet řádků nového obsahu (pro heuristiku revize) */
  lines?: number;
  /** celý soubor byl přepsán (<write> existujícího souboru) */
  rewritten?: boolean;
}

/** Jak dlouho akce trvala (pro přehled, kde se kolo zdrželo). */
export interface ActionTiming {
  tool: string;
  target: string;
  ms: number;
  /** začátek akce v ms od začátku bloku (čtecí akce běží souběžně, jejich doby se překrývají) */
  at?: number;
}

export interface RunOutcome {
  results: ActionResult[];
  /** doba každé vykonané akce v pořadí bloku */
  timings: ActionTiming[];
  changedFiles: boolean;
  changedPaths: string[];
  changes: ChangedFile[];
  statuses: string[];
  dialog: { from: "model" | "user"; text: string }[];
  plan?: string;
  suggestions: SuggestionDraft[];
  doneReviewed?: boolean;
  question?: string;
  questionOptions?: string[];
  questionMulti?: boolean;
  done?: string;
}

export const PLAN_FILE = `${STATE_DIR}/plan.md`;

export interface RunContext {
  signal?: AbortSignal;
  onStart?: (action: Action) => void;
  onEnd?: (action: Action, durationMs: number) => void;
}

const SUGGEST_KINDS = new Set(["skill", "tool", "script", "instructions", "rule", "hook", "allow", "setting", "task", "agent"]);
/** Atributy výsledku, které argument nástroje nesmí přepsat. */
const RESULT_ATTRS = new Set(["of", "tool", "status", "example", "check", "attached"]);
const PARALLEL = 6;

/**
 * Vykonává akce bloku. Souvislé skupiny čtecích akcí (read, grep, ls, glob, bundle, diagnostics)
 * běží souběžně, zápisy a příkazy v pořadí; výsledky se vrací v pořadí akcí.
 */
export class ToolRunner {
  constructor(
    private readonly host: Host,
    private readonly resultMaxChars: number,
    private readonly listener?: ChangeListener,
    private readonly bundleOptions: BundleOptions = {},
    /** dostupné skilly; čtou se až při akci, aby platily i právě vytvořené */
    private readonly skills?: () => SkillInfo[],
    /** nástroje pro <call> (seznam, schvalování); bez nich <call> hlásí, že žádné nejsou */
    private readonly tools?: CallTools,
  ) {}

  private lastChange: LastChange | undefined;
  /** kolik znaků výstupu úspěšného <run> dostane model (copyAgent.prompt.runOutputMaxChars); delší se uloží celý */
  runOutputMaxChars = OK_RUN_OUTPUT_MAX;
  /** nástroje, jejichž složku blok změnil: název → cesta ke složce */
  private touchedTools = new Map<string, string>();
  private toolCache: ScriptTool[] | undefined;

  /** Seznam nástrojů; načte se znovu, když blok změnil některou jejich složku. */
  private toolList(): ScriptTool[] {
    return (this.toolCache ??= this.tools?.list() ?? []);
  }

  private findTool(name: string | undefined): ScriptTool | undefined {
    const n = (name ?? "").trim().replace(/^\//, "").toLowerCase();
    return this.toolList().find((t) => t.name === n);
  }

  /** Smí akce běžet souběžně s ostatními čtecími? <call> jen u nástroje, který jen čte. */
  private parallel(a: Action): boolean {
    if (a.tool === "call") {
      const t = this.findTool(a.attrs.tool);
      return !!t && t.readOnly && !t.errors.length;
    }
    return READ_ONLY_TOOLS.has(a.tool) && a.tool !== "screenshot";
  }

  async runAll(actions: Action[], turn: number, ctx: RunContext = {}): Promise<RunOutcome> {
    const outcome: RunOutcome = { results: [], timings: [], changedFiles: false, changedPaths: [], changes: [], statuses: [], dialog: [], suggestions: [] };
    this.lastChange = undefined;
    this.touchedTools = new Map();
    this.toolCache = undefined;
    this.written = new Map();
    this.blockStarted = Date.now();
    let i = 0;
    while (i < actions.length) {
      if (ctx.signal?.aborted) {
        const a = actions[i++];
        if (!SILENT_TOOLS.has(a.tool)) outcome.results.push({ tool: a.tool, attrs: a.attrs, status: "skipped", output: "Not executed: the user interrupted this turn before this action.", meta: { interrupted: "before start" } });
        continue;
      }
      // skupina čtecích akcí (bez screenshotů, ty mění popředí) běží souběžně
      const group: Action[] = [];
      while (i < actions.length && this.parallel(actions[i]) && group.length < PARALLEL) group.push(actions[i++]);
      if (group.length > 1) {
        const results = await Promise.all(group.map((a) => this.timed(a, turn, outcome, ctx)));
        for (const r of results) if (r) outcome.results.push(r);
        continue;
      }
      const a = group[0] ?? actions[i++];
      const r = await this.timed(a, turn, outcome, ctx);
      if (r) outcome.results.push(r);
    }
    this.checkMs = 0;
    await this.checkWritten();
    if (this.checkMs > 0) outcome.timings.push({ tool: "check", target: "written files", ms: this.checkMs, at: Date.now() - this.checkMs - this.blockStarted });
    await this.tryChangedTools(actions, turn, outcome, ctx);
    return outcome;
  }

  /**
   * Blok změnil složku nástroje a nástroj v něm nevolal: Copy Agent ho hned vyzkouší na příkladech
   * z tool.json, aby model viděl, jestli odpovídá, jak má (nebo co je v tool.json špatně).
   * Nástroj, který může měnit data, se sám nespouští.
   */
  private async tryChangedTools(actions: Action[], turn: number, outcome: RunOutcome, ctx: RunContext): Promise<void> {
    if (!this.tools || !this.touchedTools.size) return;
    const called = new Set(actions.filter((a) => a.tool === "call").map((a) => (a.attrs.tool ?? "").trim().replace(/^\//, "").toLowerCase()));
    let index = actions.length;
    for (const [name, folder] of [...this.touchedTools].sort(([a], [b]) => a.localeCompare(b))) {
      if (called.has(name) || ctx.signal?.aborted) continue;
      const attrs = { tool: name, check: "after change" };
      const tool = this.findTool(name);
      if (!tool) {
        if ((await this.host.exists(folder)) && !(await this.host.exists(`${folder}/tool.json`))) {
          outcome.results.push({ tool: "call", attrs, status: "error", output: `The folder ${folder} has no tool.json, so it is not a tool yet. Write ${folder}/tool.json (name, description, inputSchema, run, readOnly, examples).` });
        }
        continue;
      }
      if (tool.errors.length) {
        outcome.results.push({ tool: "call", attrs, status: "error", output: `tool.json of the tool ${name} is invalid, the tool cannot run:\n${tool.errors.map((e) => "- " + e).join("\n")}` });
        continue;
      }
      if (!tool.readOnly) {
        outcome.results.push({ tool: "call", attrs, status: "ok", output: `The tool ${name} is saved. It was not tried automatically because it can change data (tool.json has no "readOnly": true); call it yourself when that is safe.` });
        continue;
      }
      if (!tool.examples.length) {
        outcome.results.push({ tool: "call", attrs, status: "error", output: `The tool ${name} is saved, but tool.json has no "examples" to try it on. Add at least one {"args": {…}} that works on any machine and changes nothing.` });
        continue;
      }
      for (const [i, ex] of tool.examples.slice(0, 3).entries()) {
        const a: Action = { tool: "call", attrs: { tool: name }, body: JSON.stringify(ex.args), index: index++ };
        ctx.onStart?.(a);
        const started = Date.now();
        const r = await this.call(a, turn, ctx.signal, i + 1);
        ctx.onEnd?.(a, Date.now() - started);
        this.host.log(`call ${name} (příklad ${i + 1}) → ${r.status}${r.meta ? " " + JSON.stringify(r.meta) : ""}`);
        outcome.results.push(r);
      }
    }
  }

  /** <call>: nástroj ze seznamu. Argumenty se ověří, skript se spustí a model dostane jeho odpověď. */
  private async call(a: Action, turn: number, signal?: AbortSignal, example?: number): Promise<ActionResult> {
    const head: Record<string, string> = { tool: (a.attrs.tool ?? "").trim() };
    if (example) head.example = String(example);
    const tool = this.findTool(a.attrs.tool);
    if (!tool) {
      const usable = this.toolList().filter((t) => !t.errors.length);
      return { tool: "call", attrs: head, status: "error", output: `Unknown tool "${a.attrs.tool ?? ""}". ${usable.length ? `Available: ${usable.map(signature).join(", ")}.` : "No tools are available here; use other actions."}` };
    }
    head.tool = tool.name;
    if (tool.errors.length) return { tool: "call", attrs: head, status: "error", output: `The tool ${tool.name} cannot run, its tool.json is invalid:\n${tool.errors.map((e) => "- " + e).join("\n")}` };
    const parsed = callInput(a.attrs, a.body);
    if (parsed.errors.length) return { tool: "call", attrs: head, status: "error", output: `${parsed.errors.join("; ")}. Signature: ${signature(tool)}`, meta: { rejected: "arguments" } };
    const r = await invokeTool(this.tools!, tool, parsed.input, parsed.fromAttrs, {
      workspace: this.host.absolutePath("."),
      roots: this.host.folders.map((f) => f.path),
      signal,
      source: example ? "example" : "model",
      host: this.host,
    });
    const attrs = { ...head, ...echoArgs(r.args) };
    if (r.rejected) return { tool: "call", attrs, status: "error", output: `Arguments rejected, the tool did not run:\n${r.rejected.map((e) => "- " + e).join("\n")}\nSignature: ${signature(tool)}`, meta: { rejected: "arguments" } };
    if (r.status === "denied" || !r.response) return { tool: "call", attrs, status: "denied", output: r.text };
    const res = r.response;
    const meta: Record<string, string | number> = { ms: res.durationMs };
    if (res.status === "error") {
      if (res.timedOut) meta.exit = "timeout";
      else if (res.exit !== null) meta.exit = res.exit;
      return { tool: "call", attrs, status: "error", output: res.text, meta };
    }
    const long = splitLongResponse(res, tool.maxChars);
    if (!long) return { tool: "call", attrs, status: "ok", output: res.text || "(the tool printed nothing)", meta };
    const rel = `${STATE_DIR}/out/call-${tool.name}-${turn}-${a.index}.${res.json !== undefined ? "json" : "txt"}`;
    await this.host.writeFile(rel, long.full);
    return {
      tool: "call",
      attrs,
      status: "ok",
      output: `${long.head}\n[… the response has ${long.full.length} characters, more than this tool's limit of ${tool.maxChars}. The complete response is in ${rel} (${long.lines} lines): read the parts you need with <read path="${rel}" lines="A-B"/>, or call the tool with narrower arguments.]`,
      meta: { ...meta, chars: long.full.length, truncated: "true" },
      fullOutputPath: rel,
    };
  }

  /** Akce, jejichž atributy jsou cesty (ne vzory): sjednotí se na kanonický tvar před vykonáním. */
  private static readonly PATH_ATTRS: Record<string, string[]> = { read: ["path"], ls: ["path"], write: ["path"], edit: ["path"], move: ["from", "to"], delete: ["path"], diagnostics: ["path"], run: ["cwd"] };

  /**
   * Cesty v akci převede na kanonický tvar (absolutní cesta uvnitř workspace → relativní, rozepsaný
   * domov → `~/.copy-agent/…`), aby review, výsledky i další kola mluvily o témže souboru. Cestu, která
   * nejde přeložit, nechá být: akce pak selže s nápovědou, jak cesty psát.
   */
  private normalizePaths(a: Action): void {
    for (const k of ToolRunner.PATH_ATTRS[a.tool] ?? []) {
      const v = a.attrs[k];
      if (!v || v === ".") continue;
      try {
        const c = this.host.canonical(v);
        if (c && c !== v) a.attrs[k] = c;
      } catch {
        /* nepřeložitelná cesta: nechat, ať akce vrátí chybu s nápovědou */
      }
    }
  }

  private async timed(a: Action, turn: number, outcome: RunOutcome, ctx: RunContext): Promise<ActionResult | undefined> {
    this.normalizePaths(a);
    ctx.onStart?.(a);
    const started = Date.now();
    const r = await this.runOne(a, turn, outcome, ctx.signal);
    ctx.onEnd?.(a, Date.now() - started);
    if (!SILENT_TOOLS.has(a.tool)) {
      const target = a.attrs.path ?? a.attrs.pattern ?? a.attrs.tool ?? a.attrs.from ?? (a.tool === "run" ? (a.body ?? "").trim().split("\n")[0].slice(0, 80) : "");
      outcome.timings.push({ tool: a.tool, target, ms: Date.now() - started, at: started - this.blockStarted });
    }
    if (!r) return undefined;
    if (r.meta?.duration === undefined && Date.now() - started > 1500) r.meta = { ...r.meta, duration: ((Date.now() - started) / 1000).toFixed(1) + "s" };
    const saveAbove = a.tool === "run" && r.status === "ok" ? Math.min(this.resultMaxChars, this.runOutputMaxChars) : this.resultMaxChars;
    if (r.output && r.output.length > saveAbove && !["read", "bundle", "skill", "call"].includes(a.tool)) r.fullOutputPath = await this.saveFullOutput(turn, a, r.output);
    this.host.log(`${a.tool} ${a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? a.attrs.from ?? a.attrs.tool ?? ""} → ${r.status}${r.meta ? " " + JSON.stringify(r.meta) : ""}`);
    return r;
  }

  private async runOne(a: Action, turn: number, outcome: RunOutcome, signal?: AbortSignal): Promise<ActionResult | undefined> {
    try {
      switch (a.tool) {
        case "read":
          return await toolRead(this.host, a.attrs);
        case "ls":
          return await toolLs(this.host, a.attrs);
        case "glob":
          return await toolGlob(this.host, a.attrs);
        case "grep":
          return await toolGrep(this.host, a.attrs);
        case "diagnostics":
          return await toolDiagnostics(this.host, a.attrs);
        case "write":
          return this.toCheck(await this.write(a, turn, outcome));
        case "edit":
          return this.toCheck(await this.edit(a, turn, outcome));
        case "move":
          return await this.move(a, turn, outcome);
        case "delete":
          return await this.delete(a, turn, outcome);
        case "run":
          return await toolRun(this.host, a.attrs, a.body ?? "", turn, a.index, signal);
        case "screenshot":
          return await takeScreenshot(this.host, turn, a.index, { window: a.attrs.window, name: a.attrs.name });
        case "bundle":
          return await toolBundle(this.host, a.attrs, turn, a.index, this.bundleOptions);
        case "plan":
          return await this.plan(a, outcome);
        case "suggest":
          return this.suggest(a, outcome);
        case "skill":
          return this.skill(a);
        case "call":
          return await this.call(a, turn, signal);
        case "change": {
          // Popis patří ke změně těsně před ním; bez ní není k čemu ho přiřadit.
          const c = this.lastChange;
          if (!c) {
            this.host.log(`<change> bez předchozí změny souboru: ${a.attrs.title ?? ""}`);
            return undefined;
          }
          this.listener?.onNote?.({ ...c, turn, title: a.attrs.title ?? "", text: (a.body ?? "").trim(), risk: a.attrs.risk, step: a.attrs.step });
          return undefined;
        }
        case "status":
          outcome.statuses.push(a.body ?? "");
          this.host.log(`● ${a.body ?? ""}`);
          return undefined;
        case "dialog": {
          const from = (a.attrs.from ?? "").toLowerCase() === "user" ? "user" : "model";
          outcome.dialog.push({ from, text: (a.body ?? "").trim() });
          return undefined;
        }
        case "ask": {
          outcome.question = a.body ?? "";
          const opts = (a.attrs.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
          if (opts.length) outcome.questionOptions = opts;
          outcome.questionMulti = /^(true|1|yes|ano)$/i.test(a.attrs.multi ?? "");
          return undefined;
        }
        case "done":
          outcome.done = a.body ?? "";
          outcome.doneReviewed = /^(true|1|yes|ano)$/i.test(a.attrs.reviewed ?? "");
          return undefined;
        default:
          return { tool: a.tool, attrs: a.attrs, status: "error", output: `Unknown action ${a.tool}` };
      }
    } catch (e) {
      return { tool: a.tool, attrs: a.attrs, status: "error", output: (e as Error).message };
    }
  }

  private guard(path: string): string | null {
    this.host.assertInside(path);
    const insideFolder = this.host.folders.length > 1 ? path.replace(/\\/g, "/").split("/").slice(1).join("/") : "";
    if (isProtectedPath(path, this.host.policy) || (insideFolder && isProtectedPath(insideFolder, this.host.policy))) return `Path "${path}" is protected by policy; changes are not allowed.`;
    return null;
  }

  private async approve(path: string, before: string, after: string): Promise<boolean> {
    return this.listener?.approve ? this.listener.approve(path, before, after) : true;
  }

  /** Zapsané soubory ke kontrole: cesta → výsledek poslední akce, která soubor zapsala. */
  private written = new Map<string, ActionResult>();
  private checkMs = 0;
  private blockStarted = 0;

  /** Zapamatuje zápis ke kontrole na konci bloku (viz checkWritten). */
  private toCheck(r: ActionResult): ActionResult {
    // zapsáno je i při částečně neúspěšném <edit> (některé hunky prošly); odmítnutý zápis soubor nezměnil
    const wrote = r.status === "ok" || (r.tool === "edit" && r.meta?.hunks !== undefined && !String(r.meta.hunks).startsWith("0/"));
    if (r.attrs.path && wrote) this.written.set(r.attrs.path, r);
    return r;
  }

  /**
   * Kontrola zapsaných souborů (zbytky protokolu, syntaxe) najednou po celém bloku: soubor se kontroluje
   * jednou v konečném stavu, všechny souběžně a Python jedním spuštěním. Nález se připíše k výsledku
   * poslední akce, která soubor zapsala; neplatný soubor = neúspěšná akce.
   */
  private async checkWritten(): Promise<void> {
    if (!this.written.size) return;
    const pending = this.written;
    this.written = new Map();
    const started = Date.now();
    const found = await checkWrittenFiles(this.host, [...pending.keys()]);
    this.checkMs = Date.now() - started;
    for (const [path, issues] of found) {
      const r = pending.get(path);
      if (!r) continue;
      const bad = issues.some((i) => i.severity === "error");
      this.host.log(`${bad ? "✗" : "⚠"} check ${path}: ${issues.map((i) => i.message).join("; ")}`);
      if (bad) r.status = "error";
      r.output = [r.output, renderIssues(path, issues)].filter(Boolean).join("\n");
      r.meta = { ...r.meta, [bad ? "invalid" : "warning"]: "true" };
    }
  }

  private markChanged(outcome: RunOutcome, change: ChangedFile): void {
    const toolName = toolNameOfPath(change.path);
    if (toolName) {
      this.touchedTools.set(toolName, change.path.replace(/\\/g, "/").replace(/(\.copy-agent\/tools\/[^/]+)\/.*$/i, "$1"));
      this.toolCache = undefined;
    }
    outcome.changedFiles = true;
    if (!outcome.changedPaths.includes(change.path)) outcome.changedPaths.push(change.path);
    outcome.changes.push(change);
  }

  /**
   * Model si vyžádal pokyny skillu (uživatel ho nespustil přes /název, ale úkol ho potřebuje).
   * Vrací celé znění, stejně jako by přišlo se zadáním.
   */
  private skill(a: Action): ActionResult {
    const all = this.skills?.() ?? [];
    const name = (a.attrs.name ?? "").trim().replace(/^\//, "").toLowerCase();
    const found = all.find((s) => s.name.toLowerCase() === name);
    if (!found?.body?.trim()) {
      const names = all.filter((s) => s.body?.trim()).map((s) => "/" + s.name);
      return { tool: "skill", attrs: a.attrs, status: "error", output: `Unknown skill "${a.attrs.name ?? ""}". ${names.length ? `Available: ${names.join(", ")}.` : "No skills are available."}` };
    }
    const args = (a.attrs.args ?? "").trim();
    return {
      tool: "skill",
      attrs: a.attrs,
      status: "ok",
      output: `Instructions of the skill /${found.name}. Follow them now, as if the user had written: /${found.name}${args ? " " + args : ""}\n\n${found.body.trim()}`,
    };
  }

  private async write(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "write", attrs: a.attrs, status: "denied", output: blocked };
    const exists = await this.host.exists(path);
    const baseline = exists ? await this.host.readFile(path) : "";
    const body = a.body ?? "";
    // ochrana obsahu: existující soubor se nesmí přepsat zástupným textem („viz výše“) ani zlomkem
    // původní délky; takový <write> by soubor fakticky smazal. Model dostane, co poslat místo toho.
    if (exists && !/^(true|1|yes)$/i.test(a.attrs.force ?? "")) {
      const refusal = refuseWrite(body, baseline);
      if (refusal) return { tool: "write", attrs: a.attrs, status: "error", output: refusal.text, meta: { refused: refusal.reason } };
    }
    const content = ensureTrailingNewline(body, baseline);
    if (!(await this.approve(path, baseline, content))) return { tool: "write", attrs: a.attrs, status: "denied", output: "The user declined this change." };
    this.listener?.onWillChange(path, exists ? "modify" : "create", baseline, turn);
    const enc = await this.host.fileEncoding(path);
    await this.host.writeFile(path, content);
    this.lastChange = { path, kind: exists ? "modify" : "create", before: baseline, after: content };
    const lines = content.split("\n").length;
    this.markChanged(outcome, { path, kind: exists ? "modify" : "create", lines, rewritten: exists });
    const meta: Record<string, string | number> = { [exists ? "overwritten" : "created"]: `${lines} lines` };
    if (!isPlainUtf8Lf(enc)) meta.encoding = describeEncodingEn(enc);
    return this.verifyEncoding(path, enc, content, { tool: "write", attrs: a.attrs, status: "ok", meta });
  }

  /**
   * Po zápisu ověří, že soubor zůstal ve svém kódování (editor mohl uložit jinak). Rozdíl se hlásí
   * jako varování ve výsledku, aby o něm věděl model i uživatel.
   */
  private async verifyEncoding(path: string, before: { encoding: string; bom: boolean; eol: "lf" | "crlf" }, content: string, r: ActionResult): Promise<ActionResult> {
    if (!/[^\x00-\x7f]/.test(content)) return r; // bez znaků mimo ASCII se kódování poznat nedá (a nezáleží na něm)
    try {
      const after = await this.host.fileEncoding(path);
      if (after.encoding === before.encoding && after.bom === before.bom) return r;
      const warn = `Warning: the encoding of ${path} changed from ${describeEncodingEn(before)} to ${describeEncodingEn(after)} while saving (the editor saved it with its own encoding). Check the file's diacritics; set VS Code "files.encoding" or "files.autoGuessEncoding" for this project if it is wrong.`;
      this.host.log(`⚠ ${warn}`);
      return { ...r, output: [r.output, warn].filter(Boolean).join("\n"), meta: { ...r.meta, encodingChanged: describeEncodingEn(after) } };
    } catch {
      return r;
    }
  }

  private async edit(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "edit", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) return { tool: "edit", attrs: a.attrs, status: "error", output: `File not found: ${path}. Use <write> to create it.` };
    const baseline = await this.host.readFile(path);
    const isDoc = /\.(md|markdown|txt)$/i.test(path);
    if (a.attrs.section) {
      const mode = a.attrs.insert === "before" || a.attrs.insert === "after" ? a.attrs.insert : "replace";
      const sec = applySection(baseline, a.attrs.section, a.body ?? "", mode);
      if (sec.error) return { tool: "edit", attrs: a.attrs, status: "error", output: sec.error };
      if (!(await this.approve(path, baseline, sec.content))) return { tool: "edit", attrs: a.attrs, status: "denied", output: "The user declined this change." };
      this.listener?.onWillChange(path, "modify", baseline, turn);
      const enc = await this.host.fileEncoding(path);
      await this.host.writeFile(path, sec.content);
      this.lastChange = { path, kind: "modify", before: baseline, after: sec.content };
      this.markChanged(outcome, { path, kind: "modify", lines: sec.content.split("\n").length });
      const r = sec.replaced!;
      const what = mode === "replace" ? `Section "${r.heading}" (lines ${r.from}-${r.to}) replaced.` : `New section inserted ${mode} "${r.heading}" (now lines ${r.from}-${r.to}).`;
      return this.verifyEncoding(path, enc, sec.content, { tool: "edit", attrs: a.attrs, status: "ok", output: what, meta: { section: r.heading, lines: `${r.from}-${r.to}` } });
    }
    const hunks = parseHunks(a.body ?? "");
    const sectionHint = isDoc ? '\n\nTip: for a markdown document, <edit path="…" section="## Heading"> replaces the whole section without any SEARCH text.' : "";
    if (hunks.length === 0) return { tool: "edit", attrs: a.attrs, status: "error", output: "No SEARCH/REPLACE hunks found. Format:\n<<<<<<< SEARCH\n(old)\n=======\n(new)\n>>>>>>> REPLACE" + sectionHint };
    const res = applyHunks(baseline, hunks);
    const meta = { hunks: `${res.applied}/${hunks.length}` };
    const notes = res.notes.join("\n");
    if (res.applied === 0) return { tool: "edit", attrs: a.attrs, status: "error", output: res.failures.map((f) => `Hunk ${f.hunk}: ${f.reason}`).join("\n\n") + sectionHint, meta };
    if (!(await this.approve(path, baseline, res.content))) return { tool: "edit", attrs: a.attrs, status: "denied", output: "The user declined this change.", meta };
    this.listener?.onWillChange(path, "modify", baseline, turn);
    const enc = await this.host.fileEncoding(path);
    await this.host.writeFile(path, res.content);
    this.lastChange = { path, kind: "modify", before: baseline, after: res.content };
    this.markChanged(outcome, { path, kind: "modify", lines: res.content.split("\n").length });
    const failText = res.failures.map((f) => `Hunk ${f.hunk} FAILED (others applied): ${f.reason}`).join("\n\n");
    const output = [failText, notes].filter(Boolean).join("\n\n");
    return this.verifyEncoding(path, enc, res.content, { tool: "edit", attrs: a.attrs, status: res.failures.length ? "error" : "ok", output: output || undefined, meta });
  }

  private async move(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const from = a.attrs.from;
    const to = a.attrs.to;
    const blocked = this.guard(from) ?? this.guard(to);
    if (blocked) return { tool: "move", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(from))) return { tool: "move", attrs: a.attrs, status: "error", output: `File not found: ${from}` };
    if (await this.host.exists(to)) return { tool: "move", attrs: a.attrs, status: "error", output: `Target already exists: ${to}` };
    const content = await this.host.readFile(from);
    this.listener?.onWillDelete(from, content, turn);
    this.listener?.onWillChange(to, "create", "", turn);
    await this.host.moveFile(from, to);
    this.lastChange = { path: to, kind: "create", before: "", after: content };
    this.markChanged(outcome, { path: from, kind: "delete" });
    this.markChanged(outcome, { path: to, kind: "move" });
    return { tool: "move", attrs: a.attrs, status: "ok" };
  }

  private async delete(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "delete", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) return { tool: "delete", attrs: a.attrs, status: "error", output: `File not found: ${path}` };
    if (!(await this.host.confirmDelete(path))) return { tool: "delete", attrs: a.attrs, status: "denied", output: "The user declined the deletion." };
    const content = await this.host.readFile(path);
    this.listener?.onWillDelete(path, content, turn);
    await this.host.deleteFile(path);
    this.lastChange = { path, kind: "delete", before: content, after: "" };
    this.markChanged(outcome, { path, kind: "delete" });
    return { tool: "delete", attrs: a.attrs, status: "ok" };
  }

  private async plan(a: Action, outcome: RunOutcome): Promise<ActionResult> {
    const body = (a.body ?? "").trim() + "\n";
    const items = (body.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []).length;
    const done = (body.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
    if (items === 0) return { tool: "plan", attrs: a.attrs, status: "error", output: "The plan must be a markdown checklist with `- [ ]` / `- [x]` items." };
    await this.host.writeFile(PLAN_FILE, body);
    outcome.plan = body;
    return { tool: "plan", attrs: a.attrs, status: "ok", meta: { items, done } };
  }

  private suggest(a: Action, outcome: RunOutcome): ActionResult {
    const kind = (a.attrs.kind ?? "").toLowerCase();
    if (!SUGGEST_KINDS.has(kind)) return { tool: "suggest", attrs: a.attrs, status: "error", output: `Unknown suggestion kind "${a.attrs.kind}"; use one of ${[...SUGGEST_KINDS].join(", ")}.` };
    const scope = (a.attrs.scope ?? "").toLowerCase() === "global" ? "global" : "project";
    const update = a.attrs.update?.trim() || undefined;
    const lang = a.attrs.lang?.trim() || undefined;
    const file = a.attrs.file?.trim() || undefined;
    outcome.suggestions.push({ kind, scope, title: a.attrs.title ?? kind, body: (a.body ?? "").trim(), update, lang, file });
    return { tool: "suggest", attrs: { kind, scope, title: a.attrs.title ?? kind, ...(update ? { update } : {}) }, status: "ok", meta: { queued: "awaiting user approval" } };
  }

  private async saveFullOutput(turn: number, a: Action, output: string): Promise<string> {
    const rel = `${STATE_DIR}/out/${a.tool}-${turn}-${a.index}.txt`;
    try {
      await this.host.writeFile(rel, output);
      return rel;
    } catch {
      return "";
    }
  }
}

/** Krátké textové a číselné argumenty volání se zopakují ve výsledku, aby šly výsledky přiřadit k voláním. */
function echoArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (Object.keys(out).length >= 4) break;
    if (RESULT_ATTRS.has(k) || !/^[a-zA-Z_][\w-]*$/.test(k)) continue;
    if (typeof v === "string" ? v.length <= 80 && !v.includes("\n") : typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** Tělo <write>, které není obsah souboru, ale odkaz („viz výše“, „beze změny“, „…“). */
export function looksLikePlaceholder(body: string): boolean {
  const t = body.trim();
  if (!t) return true;
  if (t.length > 240) return false;
  if (/^(\.{3}|…|\/\/ ?\.{3}|# ?\.{3}|<!-- ?\.{3} ?-->)$/.test(t)) return true;
  return /\b(viz|see|as|jak|jako)\s+(above|below|výše|níže|nahoře|dole|previous|earlier|chat)\b|\b(zkopíruj|copy|paste|vlož|použij|use)\b.*\b(above|výše|z chatu|from (the )?chat|z odpovědi)\b|\b(unchanged|beze změny|same as (before|above)|stejn[ýé] jako|no changes?|without changes?)\b|\[(celý|full|complete|whole)\s+(soubor|obsah|file|content)/i.test(
    t,
  );
}

/**
 * Odmítne přepsání existujícího souboru zástupným textem nebo zlomkem původní délky (model napsal
 * obsah do chatu mimo blok, nebo zapomněl zbytek). Vrací důvod a text pro model, nebo null.
 */
export function refuseWrite(body: string, baseline: string): { reason: string; text: string } | null {
  if (looksLikePlaceholder(body)) {
    return {
      reason: "placeholder body",
      text: `REFUSED: the body of this <write> looks like a placeholder (${JSON.stringify(body.trim().slice(0, 80))}), not the file content; writing it would wipe the file. The file was NOT changed. Send the COMPLETE file content inside <write>, or change parts of it with <edit> SEARCH/REPLACE hunks.`,
    };
  }
  const b = baseline.trim().length;
  const n = body.trim().length;
  if (b >= 300 && n < b * 0.3) {
    return {
      reason: "content shrink",
      text: `REFUSED: the new content (${n} chars) is much shorter than the existing file (${b} chars); overwriting would delete most of it. The file was NOT changed. Use <edit> hunks for partial changes, or resend <write path="…" force="true"> if the file really should shrink that much.`,
    };
  }
  return null;
}

function ensureTrailingNewline(content: string, baseline: string): string {
  if (content.endsWith("\n")) return content;
  if (baseline && !baseline.endsWith("\n")) return content;
  return content + "\n";
}
