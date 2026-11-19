import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/engine/SessionData";
import { TurnEngine } from "../src/engine/TurnEngine";
import { Host } from "../src/host/Host";
import { NodeHost } from "../src/host/NodeHost";
import { BUILTIN_TOOLS } from "../src/index/builtin";
import { enclosingSymbol, extractSymbols, symbolRange } from "../src/index/symbols";
import { bloomHas, buildBloom, requiredFragments, trigramsOf } from "../src/index/tokens";
import { WorkspaceIndex } from "../src/index/WorkspaceIndex";
import { DEFAULT_OPTIONS } from "../src/protocol/prompt";
import { decodeBytes, detectEncoding, detectEncodingName, encodeText } from "../src/tools/encoding";
import { toolGrep } from "../src/tools/grep";
import { CallTools, ToolGate } from "../src/tools/scripttools";

const PYTHON = ["python3", "python"].find((c) => {
  try {
    return /Python 3/.test(execFileSync(c, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return false;
  }
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const PKG = [
  "CREATE OR REPLACE PACKAGE BODY pkg_faktury AS",
  "",
  "  c_sazba CONSTANT NUMBER := 21;",
  "",
  "  -- vystaví fakturu k objednávce",
  "  PROCEDURE vystav_fakturu(p_objednavka_id IN NUMBER, p_rezim IN VARCHAR2) IS",
  "    v_zaklad NUMBER(14,2);",
  "  BEGIN",
  "    v_zaklad := spocti_zaklad(p_objednavka_id);",
  "    zapis_hlavicku(p_objednavka_id, v_zaklad);",
  "  END vystav_fakturu;",
  "",
  "  FUNCTION spocti_zaklad(p_id IN NUMBER) RETURN NUMBER IS",
  "  BEGIN",
  "    RETURN 0; -- částka bez DPH",
  "  END spocti_zaklad;",
  "",
  "END pkg_faktury;",
  "/",
  "",
].join("\n");

describe("fingerprints and required fragments", () => {
  it("a fingerprint never denies text that is there, whatever the letter case", () => {
    const text = "  PROCEDURE vystav_fakturu(p_id IN NUMBER) IS\n    v_částka := NVL(v_dph, 0); -- Žluťoučký kůň\n";
    const bloom = buildBloom(text);
    for (const frag of ["vystav_fakturu", "VYSTAV_FAKT", "NVL(v_dph", "částka", "ČÁSTKA", "žluťoučký kůň", "p_id in number"]) expect(bloomHas(bloom, trigramsOf(frag)), frag).toBe(true);
    expect(bloomHas(bloom, trigramsOf("zrus_fakturu"))).toBe(false);
    // text přes konec řádku v otisku není (hledá se po řádcích)
    expect(bloomHas(bloom, trigramsOf("IS\n    v_"))).toBe(true); // konec řádku trojice dělí, zbylé kusy v textu jsou
  });

  it("takes from a regex only what every match must contain", () => {
    const cases: [string, string[][] | null][] = [
      ["isValidEmail|validateEmail", [["isValidEmail"], ["validateEmail"]]],
      ["foo.*bar", [["foo", "bar"]]],
      ["NVL\\(v_dph", [["NVL(v_dph"]]],
      ["ab\\.cdef", [["ab.cdef"]]],
      ["^\\s*create\\b", [["create"]]],
      ["\\d+abc", [["abc"]]],
      ["colou?r", [["colo"]]],
      ["a{0,2}bcd", [["bcd"]]],
      ["abc+def", [["abc", "def"]]],
      ["(a|b)cde", [["cde"]]],
      ["foo(?=bar)", [["foo"]]],
      ["(foo)?barbar", [["barbar"]]],
      // bez použitelného kusu se musí prohledat všechno
      ["ab?c", null],
      ["x[qQ]7\\b", null],
      ["abc|", null],
      ["abc|[0-9]+", null],
      [".*", null],
      ["(unclosed", null],
    ];
    for (const [pattern, want] of cases) expect(requiredFragments(pattern), pattern).toEqual(want);
  });
});

describe("encoding helpers", () => {
  it("the fast name detection agrees with the full detection", () => {
    const samples = [Buffer.from("plain ascii\n"), Buffer.from("žluťoučký\r\n", "utf8"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom", "utf8")]), encodeText("příliš žluťoučký kůň\n", { encoding: "windows-1250", bom: false, eol: "lf" }), Buffer.from("\ufeffutf16 text s háčky\n", "utf16le")];
    for (const b of samples) expect(detectEncodingName(b)).toBe(detectEncoding(b).encoding);
    expect(detectEncoding(Buffer.from("a\r\nb\r\nc\n")).eol).toBe("crlf");
    expect(detectEncoding(Buffer.from("a\nb\nc\r\n")).eol).toBe("lf");
  });

  it("decodes every byte of a single-byte code page", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const text = decodeBytes(all, "windows-1250");
    expect(text).toHaveLength(256);
    expect(text.slice(0x41, 0x44)).toBe("ABC");
    expect(text[0xe8]).toBe("č");
    expect(text[0x9e]).toBe("ž");
    expect(encodeText("čžř ABC", { encoding: "windows-1250", bom: false, eol: "lf" }).equals(Buffer.from([0xe8, 0x9e, 0xf8, 0x20, 0x41, 0x42, 0x43]))).toBe(true);
  });
});

describe("symbols", () => {
  it("finds PL/SQL packages with their procedures and functions", () => {
    const syms = extractSymbols(PKG, "db/pkg_faktury.pkb");
    expect(syms.map((s) => [s.kind, s.name, s.line, s.level, s.container])).toEqual([
      ["package body", "pkg_faktury", 1, 0, undefined],
      ["procedure", "vystav_fakturu", 6, 1, "pkg_faktury"],
      ["function", "spocti_zaklad", 13, 1, "pkg_faktury"],
    ]);
    const lines = PKG.split("\n");
    // rozsah procedury i s komentářem nad ní, bez následující funkce
    expect(symbolRange(lines, syms, 1)).toEqual({ from: 5, to: 11 });
    expect(enclosingSymbol(syms, 9)?.name).toBe("vystav_fakturu");
    expect(enclosingSymbol(syms, 14)?.name).toBe("spocti_zaklad");
    const spec = extractSymbols("create or replace package pkg_x as\n  procedure a(p number);\n  function b return number;\nend pkg_x;\n/\ncreate or replace procedure samostatna is\nbegin null; end;\n/\ncreate table t_faktura (id number);\n", "x.sql");
    expect(spec.map((s) => `${s.kind} ${s.container ? s.container + "." : ""}${s.name}`)).toEqual(["package pkg_x", "procedure pkg_x.a", "function pkg_x.b", "procedure samostatna", "table t_faktura"]);
  });

  it("finds classes, methods and functions in TypeScript and Python", () => {
    const ts = ["export class InvoiceService {", "  private total = 0;", "", "  async load(id: number): Promise<void> {", "    if (id) {", "      await this.fetch(id);", "    }", "  }", "", "  static create(): InvoiceService {", "    return new InvoiceService();", "  }", "}", "", "export function roundVat(value: number): number {", "  const x = Math.round(value);", "  return x;", "}", "", "export const LIMIT = 5;"].join("\n");
    expect(extractSymbols(ts, "src/invoice.ts").map((s) => `${s.kind} ${s.container ? s.container + "." : ""}${s.name}@${s.line}`)).toEqual(["class InvoiceService@1", "method InvoiceService.load@4", "method InvoiceService.create@10", "function roundVat@15", "const LIMIT@20"]);
    const py = ["import os", "", "class Loader:", "    def __init__(self):", "        self.x = 1", "", "    async def load(self, path):", "        return path", "", "def main():", "    def inner():", "        pass", "    return inner"].join("\n");
    expect(extractSymbols(py, "tools/loader.py").map((s) => `${s.kind} ${s.container ? s.container + "." : ""}${s.name}@${s.line}`)).toEqual(["class Loader@3", "method Loader.__init__@4", "method Loader.load@7", "function main@10", "function main.inner@11"]);
    expect(extractSymbols("# Title\n\n```\n# not a heading\n```\n\n## Section\n", "README.md").map((s) => `${s.level}:${s.name}`)).toEqual(["0:Title", "1:Section"]);
  });
});

describe("WorkspaceIndex", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp("ca-index-");
    write(dir, "db/pkg_faktury.pkb", PKG);
    write(dir, "db/pkg_sklad.pkb", "CREATE OR REPLACE PACKAGE BODY pkg_sklad AS\n  PROCEDURE prijem(p_id IN NUMBER) IS\n  BEGIN\n    pkg_faktury.vystav_fakturu(p_id, 'radek');\n  END prijem;\nEND pkg_sklad;\n");
    write(dir, "src/app.ts", "export function start() {\n  return 1;\n}\n");
    write(dir, "docs/cp1250.txt", encodeText("Příliš žluťoučký kůň\r\núpěl ďábelské ódy\r\n", { encoding: "windows-1250", bom: false, eol: "crlf" }));
    write(dir, "node_modules/x/index.js", "module.exports = 'vystav_fakturu';\n");
    write(dir, ".svn/pristine/ab/abcdef.svn-base", "vystav_fakturu\n");
    write(dir, "generated/out.ts", "export const vystav_fakturu = 1;\n");
    write(dir, ".gitignore", "generated\n");
    write(dir, "img/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (extra: Partial<ConstructorParameters<typeof WorkspaceIndex>[0]> = {}) => new WorkspaceIndex({ roots: [{ name: "ws", fsPath: dir }], ...extra });

  it("lists files without version-control, dependency and ignored folders", async () => {
    const index = make();
    expect(await index.list()).toEqual([".gitignore", "db/pkg_faktury.pkb", "db/pkg_sklad.pkb", "docs/cp1250.txt", "img/logo.png", "src/app.ts"]);
    expect(await index.match("db/**/*.pkb")).toEqual(["db/pkg_faktury.pkb", "db/pkg_sklad.pkb"]);
    expect(await index.match("**/*.ts")).toEqual(["src/app.ts"]);
    expect(index.searchable("img/logo.png")).toBe(false);
  });

  it("reads text once, in its own encoding, and re-reads it only after a change", async () => {
    const index = make();
    await index.list();
    expect(await index.text("docs/cp1250.txt")).toBe("Příliš žluťoučký kůň\núpěl ďábelské ódy\n");
    await index.whenDeep();
    const before = index.stats().diskReads;
    expect(await index.text("db/pkg_faktury.pkb")).toBe(PKG);
    expect(await index.text("db/pkg_faktury.pkb")).toBe(PKG);
    expect(index.stats().diskReads).toBe(before);
    expect(await index.text("img/logo.png")).toBeUndefined();
    // změna hlášená hostitelem
    write(dir, "db/pkg_faktury.pkb", PKG.replace("21", "12"));
    index.touch("db/pkg_faktury.pkb");
    expect(await index.text("db/pkg_faktury.pkb")).toContain("c_sazba CONSTANT NUMBER := 12");
    expect(index.stats().diskReads).toBe(before + 1);
  });

  it("follows files created, changed and deleted, reported or found on the next pass", async () => {
    const index = make();
    await index.whenDeep();
    write(dir, "src/new.ts", "export const novy_symbol_xyz = 1;\n");
    index.touch(path.join(dir, "src/new.ts"));
    expect(await index.list()).toContain("src/new.ts");
    expect(index.candidates([["novy_symbol_xyz"]], await index.list())).toEqual(["src/new.ts"]);
    fs.rmSync(path.join(dir, "src/new.ts"));
    index.touch("src/new.ts");
    expect(await index.list()).not.toContain("src/new.ts");
    // změny, o kterých index neví: pozná je po markStale (běžel příkaz)
    write(dir, "db/novy.sql", "create table t_nova (id number);\n");
    fs.rmSync(path.join(dir, "src"), { recursive: true });
    expect(await index.list()).not.toContain("db/novy.sql");
    index.markStale();
    expect(await index.list()).toEqual([".gitignore", "db/novy.sql", "db/pkg_faktury.pkb", "db/pkg_sklad.pkb", "docs/cp1250.txt", "img/logo.png"]);
    // smazaná složka ohlášená jednou událostí
    fs.rmSync(path.join(dir, "docs"), { recursive: true });
    index.touch("docs");
    expect(await index.list()).not.toContain("docs/cp1250.txt");
  });

  it("narrows a search to files that can contain the text", async () => {
    const index = make();
    const all = await index.list();
    await index.whenDeep();
    expect(index.candidates([["vystav_fakturu"]], all)).toEqual(["db/pkg_faktury.pkb", "db/pkg_sklad.pkb"]);
    expect(index.candidates([["VYSTAV_FAKTURU"]], all)).toEqual(["db/pkg_faktury.pkb", "db/pkg_sklad.pkb"]);
    expect(index.candidates([["prijem"], ["function start"]], all)).toEqual(["db/pkg_sklad.pkb", "src/app.ts"]);
    expect(index.candidates([["žluťoučký"]], all)).toContain("docs/cp1250.txt");
    expect(index.candidates([["tohle_nikde_neni"]], all)).toEqual([]);
  });

  it("survives a restart: the saved index is loaded and only changed files are read", async () => {
    const file = path.join(tmp("ca-index-store-"), "index.bin");
    const first = make({ storageFile: file });
    await first.whenDeep();
    await first.dispose();
    expect(fs.existsSync(file)).toBe(true);
    write(dir, "src/app.ts", "export function start() {\n  return 2; // zmena_po_restartu\n}\n");
    const second = make({ storageFile: file });
    await second.whenDeep();
    expect(second.stats().diskReads).toBe(1);
    const all = await second.list();
    expect(second.candidates([["vystav_fakturu"]], all)).toEqual(["db/pkg_faktury.pkb", "db/pkg_sklad.pkb"]);
    expect(second.candidates([["zmena_po_restartu"]], all)).toEqual(["src/app.ts"]);
    expect((await second.symbolsOf("db/pkg_faktury.pkb")).map((s) => s.name)).toEqual(["pkg_faktury", "vystav_fakturu", "spocti_zaklad"]);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("prefers unsaved editor text and keeps working with a tiny cache", async () => {
    const unsaved = new Map([["src/app.ts", "export function start() {\n  return neulozeny_text;\n}\n"]]);
    const index = make({ unsaved: () => unsaved, cacheBytes: 300 });
    const all = await index.list();
    await index.whenDeep();
    expect(await index.text("src/app.ts")).toContain("neulozeny_text");
    const seen: string[] = [];
    await index.eachText(all, (rel, text) => void (text !== undefined && seen.push(rel)));
    await index.eachText(all, () => undefined);
    expect(seen).toEqual([".gitignore", "db/pkg_faktury.pkb", "db/pkg_sklad.pkb", "docs/cp1250.txt", "src/app.ts"]);
    expect(index.stats().cacheBytes).toBeLessThanOrEqual(300);
  });

  it("names files by workspace folder when there are several", async () => {
    const other = tmp("ca-index-b-");
    write(other, "sql/x.sql", "create table t_x (id number);\n");
    const index = new WorkspaceIndex({ roots: [{ name: "NIP", fsPath: dir }, { name: "SHARED", fsPath: other }] });
    const all = await index.list();
    expect(all).toContain("NIP/db/pkg_faktury.pkb");
    expect(all).toContain("SHARED/sql/x.sql");
    expect(await index.match("**/*.sql")).toEqual(["SHARED/sql/x.sql"]);
    expect(await index.match("NIP/db/*.pkb")).toEqual(["NIP/db/pkg_faktury.pkb", "NIP/db/pkg_sklad.pkb"]);
    expect(await index.match("SHARED")).toEqual(["SHARED/sql/x.sql"]);
    expect(index.relOf(path.join(other, "sql", "x.sql"))).toBe("SHARED/sql/x.sql");
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe("grep through the index", () => {
  let dir: string;
  let host: NodeHost;
  /** tentýž workspace bez indexu: hledání hrubou silou jako dřív */
  let plain: Host;
  const WORDS = "faktura objednavka dobropis sklad zakaznik polozka platba dph zaokrouhleni kurz mena ucet doklad radek částka sleva Žluťoučký kůň NVL(v_dph, ROUND( p_id IN NUMBER".split(" ");

  beforeEach(() => {
    dir = tmp("ca-grep-");
    let seed = 42;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 60; i++) {
      const lines = Array.from({ length: 5 + rnd(40) }, () => Array.from({ length: 2 + rnd(7) }, () => WORDS[rnd(WORDS.length)]).join(rnd(3) ? " " : "_") + (rnd(4) ? ";" : ""));
      const text = lines.join(i % 4 === 0 ? "\r\n" : "\n") + "\n";
      write(dir, `m${i % 6}/f${i}.${["sql", "ts", "txt"][i % 3]}`, i % 5 === 0 ? encodeText(text, { encoding: "windows-1250", bom: false, eol: "lf" }) : text);
    }
    write(dir, "m0/needle.sql", "  PROCEDURE vystav_unikatni(p_id IN NUMBER) IS -- JehlaXq7\n");
    host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    plain = { listFiles: (g: string, max?: number) => host.listFiles(g, max), readFile: (f: string) => host.readFile(f) } as unknown as Host;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("gives exactly what a brute-force search gives, for literals and regexes", async () => {
    await host.index.whenDeep();
    const patterns = [
      "vystav_unikatni", "VYSTAV_UNIKATNI", "JehlaXq7", "jehlaxq7|dobropis_sklad", "faktura", "částka", "ČÁSTKA", "žluťoučký kůň", "NVL\\(v_dph", "ROUND\\(", "p_id IN NUMBER",
      "x[qQ]7\\b", "^\\s*PROCEDURE\\b", "sklad.*platba", "kurz_mena;$", "(dph|mena)_ucet", "zakazni[kc]", "doklad\\s+radek", "a{0,1}polozka", "nikde_to_neni", "\\bucet\\b", "sleva(?!_)",
    ];
    for (const pattern of patterns) {
      const variants: Record<string, string>[] = [{}, { glob: "m1/**" }, { context: "1" }];
      for (const extra of variants) {
        const attrs: Record<string, string> = { pattern, ...extra };
        const a = await toolGrep(host, attrs);
        const b = await toolGrep(plain, attrs);
        expect(a.output, JSON.stringify(attrs)).toBe(b.output);
        expect(a.meta?.matches, JSON.stringify(attrs)).toBe(b.meta?.matches);
      }
    }
  });

  it("reads only the files that can match", async () => {
    await host.index.whenDeep();
    // mezipaměť pryč: počítají se skutečná čtení z disku
    const cold = new WorkspaceIndex({ roots: [{ name: "ws", fsPath: dir }], cacheBytes: 0 });
    await cold.whenDeep();
    const before = cold.stats().diskReads;
    const r = await toolGrep({ ...plain, index: cold } as unknown as Host, { pattern: "vystav_unikatni" });
    expect(r.meta).toMatchObject({ matches: 1, files: 61 });
    expect(cold.stats().diskReads - before).toBe(1);
  });

  it("sees a file written by the agent in the same block", async () => {
    const tools: CallTools = { list: () => BUILTIN_TOOLS, gate: new ToolGate({ get: () => undefined, set: () => undefined }, async () => true) };
    const engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", tools, runtime: async () => ({ platform: "linux" }) });
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<grep pattern="uplne_novy_symbol"/>\n<write path="m9/novy.sql">\nCREATE OR REPLACE PROCEDURE uplne_novy_symbol IS\nBEGIN\n  NULL;\nEND;\n</write>\n<grep pattern="uplne_novy_symbol"/>\n<glob pattern="m9/*"/>\n<call tool="symbols" name="uplne_novy"/>\n</copy>'), 100);
    if (step.kind !== "next") throw new Error(step.kind);
    const [g1, , g2, glob, sym] = step.record.results;
    expect(g1.output).toBe("(no matches)");
    expect(g2.output).toBe("m9/novy.sql:1: CREATE OR REPLACE PROCEDURE uplne_novy_symbol IS");
    expect(glob.output).toBe("m9/novy.sql");
    expect(sym.output).toContain("m9/novy.sql:1: procedure uplne_novy_symbol");
  });
});

describe("built-in tools", () => {
  let dir: string;
  let engine: TurnEngine;
  const call = async (body: string) => {
    const step = await engine.execute(createSession("task"), engine.parse(`<copy turn="1">\n${body}\n</copy>`), 100);
    if (step.kind !== "next") throw new Error(step.kind);
    return step.record.results;
  };

  beforeEach(() => {
    dir = tmp("ca-builtin-");
    write(dir, "db/pkg_faktury.pkb", PKG);
    write(dir, "db/pkg_sklad.pkb", "CREATE OR REPLACE PACKAGE BODY pkg_sklad AS\n  PROCEDURE prijem(p_id IN NUMBER) IS\n  BEGIN\n    pkg_faktury.vystav_fakturu(p_id, 'radek');\n  END prijem;\nEND pkg_sklad;\n");
    write(dir, "src/invoice.ts", "export class InvoiceService {\n  vystav_fakturu(id: number) {\n    return id;\n  }\n}\n");
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    const tools: CallTools = { list: () => BUILTIN_TOOLS, gate: new ToolGate({ get: () => undefined, set: () => undefined }, async () => false) };
    engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", tools, runtime: async () => ({ platform: "linux" }) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("are offered to the model and need no approval", async () => {
    const ctx = await engine.gatherContext(undefined, undefined, "task");
    expect(ctx.tools?.map((t) => t.name)).toEqual(["symbols", "code", "usages", "outline", "files"]);
    const [r] = await call('<call tool="symbols" name="vystav"/>');
    expect(r.status).toBe("ok");
    expect(r.output).toBe(["db/pkg_faktury.pkb:6: procedure pkg_faktury.vystav_fakturu  |  PROCEDURE vystav_fakturu(p_objednavka_id IN NUMBER, p_rezim IN VARCHAR2) IS", "src/invoice.ts:2: method InvoiceService.vystav_fakturu  |  vystav_fakturu(id: number) {"].join("\n"));
  });

  it("symbols narrows by kind and container; code returns the body by name", async () => {
    const [byKind, byContainer, body, similar] = await call('<call tool="symbols" name="vystav_fakturu" kind="method"/>\n<call tool="symbols" name="pkg_faktury.spocti"/>\n<call tool="code" name="pkg_faktury.vystav_fakturu"/>\n<call tool="code" name="vystav"/>');
    expect(byKind.output).toMatch(/^src\/invoice\.ts:2: method/);
    expect(byContainer.output).toMatch(/^db\/pkg_faktury\.pkb:13: function pkg_faktury\.spocti_zaklad/);
    expect(body.output).toBe(
      ["### db/pkg_faktury.pkb:5-11 (procedure pkg_faktury.vystav_fakturu)", " 5|   -- vystaví fakturu k objednávce", " 6|   PROCEDURE vystav_fakturu(p_objednavka_id IN NUMBER, p_rezim IN VARCHAR2) IS", " 7|     v_zaklad NUMBER(14,2);", " 8|   BEGIN", " 9|     v_zaklad := spocti_zaklad(p_objednavka_id);", "10|     zapis_hlavicku(p_objednavka_id, v_zaklad);", "11|   END vystav_fakturu;"].join("\n"),
    );
    expect(similar.output).toMatch(/No definition is named exactly "vystav"\. Similar:\ndb\/pkg_faktury\.pkb:6: procedure pkg_faktury\.vystav_fakturu/);
  });

  it("usages lists every use with the definition around it; outline and files describe the workspace", async () => {
    const [usages, outline, files, none] = await call('<call tool="usages" name="vystav_fakturu"/>\n<call tool="outline" path="db"/>\n<call tool="files" query="pkg sklad"/>\n<call tool="usages" name="neexistuje_to"/>');
    expect(usages.output).toBe(
      [
        "4 occurrence(s) in 3 file(s):",
        "db/pkg_faktury.pkb:6: [definition] PROCEDURE vystav_fakturu(p_objednavka_id IN NUMBER, p_rezim IN VARCHAR2) IS",
        "db/pkg_faktury.pkb:11: [in pkg_faktury.vystav_fakturu] END vystav_fakturu;",
        "db/pkg_sklad.pkb:4: [in pkg_sklad.prijem] pkg_faktury.vystav_fakturu(p_id, 'radek');",
        "src/invoice.ts:2: [definition] vystav_fakturu(id: number) {",
      ].join("\n"),
    );
    expect(outline.output).toContain("db/pkg_faktury.pkb (20 lines)\nL1: CREATE OR REPLACE PACKAGE BODY pkg_faktury AS\nL6:   PROCEDURE vystav_fakturu");
    expect(outline.output).toContain("db/pkg_sklad.pkb (7 lines)");
    expect(files.output).toMatch(/^db\/pkg_sklad\.pkb \(7 lines, \d+ B, changed \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    expect(none.output).toBe('No usage of "neexistuje_to" found.');
  });
});

describe("checks after writing", () => {
  let dir: string;
  let engine: TurnEngine;
  beforeEach(() => {
    dir = tmp("ca-check-");
    engine = new TurnEngine(new NodeHost(dir, { autoConfirm: true, log: () => undefined }), { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", runtime: async () => ({ platform: "linux" }) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  (PYTHON ? it : it.skip)("checks every written file once, in its final state", async () => {
    const reply = [
      '<copy turn="1">',
      '<write path="ok.py">\ndef f():\n    return 1\n</write>',
      '<write path="bad1.py">\ndef f(:\n    return 1\n</write>',
      '<write path="bad2.py">\nx = (1,\n</write>',
      // rozbitý zápis opravený v témže bloku chybou není
      '<write path="fixed.py">\ndef g(:\n    pass\n</write>',
      '<edit path="fixed.py">\n<<<<<<< SEARCH\ndef g(:\n=======\ndef g():\n>>>>>>> REPLACE\n</edit>',
      '<write path="data.json">\n{"a": 1,}\n</write>',
      "</copy>",
    ].join("\n");
    const step = await engine.execute(createSession("task"), engine.parse(reply), 100);
    if (step.kind !== "next") throw new Error(step.kind);
    const by = Object.fromEntries(step.record.results.map((r, i) => [`${i}:${r.tool}:${r.attrs.path}`, r]));
    expect(by["0:write:ok.py"].status).toBe("ok");
    expect(by["1:write:bad1.py"]).toMatchObject({ status: "error", meta: { invalid: "true" } });
    expect(by["1:write:bad1.py"].output).toMatch(/Python syntax: line 1/);
    expect(by["2:write:bad2.py"].output).toMatch(/Python syntax: line 1/);
    expect(by["3:write:fixed.py"].status).toBe("ok");
    expect(by["4:edit:fixed.py"].status).toBe("ok");
    expect(by["5:write:data.json"].output).toMatch(/JSON syntax/);
  });
});

describe("index freshness with a file watcher", () => {
  it("waits for reported changes after a command instead of walking the disk, and re-checks in the background", async () => {
    const dir = tmp("ca-settle-");
    write(dir, "a.sql", "create table t_a (id number);\n");
    const index = new WorkspaceIndex({ roots: [{ name: "ws", fsPath: dir }] });
    await index.whenDeep();
    // příkaz vytvořil soubor; událost o něm dorazí až za chvíli
    write(dir, "b.sql", "create table t_b (id number);\n");
    index.settle(150);
    setTimeout(() => index.touch(path.join(dir, "b.sql")), 60);
    const started = Date.now();
    expect(await index.list()).toEqual(["a.sql", "b.sql"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    // změna, kterou nikdo neohlásil: najde ji průchod na pozadí, dotazy na něj nečekají
    write(dir, "c.sql", "create table t_c (id number);\n");
    expect(await index.list()).toEqual(["a.sql", "b.sql"]);
    index.refreshInBackground();
    await new Promise((r) => setTimeout(r, 100));
    expect(await index.list()).toEqual(["a.sql", "b.sql", "c.sql"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
