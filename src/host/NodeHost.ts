import * as fs from "fs/promises";
import * as path from "path";
import { WorkspaceIndex } from "../index/WorkspaceIndex";
import { canonicalRel, resolveRel, RootFolder } from "../protocol/roots";
import { applyEol, decodeBytes, DEFAULT_ENCODING, detectEncoding, encodeText, FileEncoding, normalizeEncoding, toLf } from "../tools/encoding";
import { Host, HostPolicy, RunResult } from "./Host";
import { captureScreenshot } from "./screenshot";
import { spawnCommand, workspaceEnv } from "./spawn";

export const DEFAULT_POLICY: HostPolicy = {
  autoAllow: ["npm test", "npm run build", "npm run lint", "npm run typecheck", "npx tsc", "tsc", "git status", "git diff", "git log", "npx vitest run", "pytest", "python -m pytest", "python -m unittest", "cargo test", "cargo build", "go test", "go build", "dotnet build", "dotnet test"],
  allowPatterns: [],
  deny: ["rm -rf /", "git push --force", "git push -f", "sudo ", "format ", "del /s", "Remove-Item -Recurse", "rmdir /s"],
  protectedPaths: [".env", ".env.*", ".git/**", "node_modules/**", "**/*.pem", "**/*.key"],
};

export interface NodeHostOptions {
  policy?: Partial<HostPolicy>;
  /** headless: potvrzovací dotazy se automaticky schválí (a zalogují) */
  autoConfirm?: boolean;
  log?: (line: string) => void;
  defaultEncoding?: string;
  defaultEol?: "lf" | "crlf";
  fallbackEncoding?: string;
  /** soubor pro uložení indexu mezi spuštěními (bez něj se index staví vždy znovu) */
  indexFile?: string;
  /**
   * Po kolika ms si index znovu projde disk. Výchozí 0 = při každém dotazu (tenhle host soubory nesleduje,
   * takže jinak by neviděl změny zvenčí). Kdo změny hlásí sám přes `index.touch`, dá Infinity.
   */
  indexMaxAgeMs?: number;
}

/** Host nad Node API – pro CLI harness a testy. */
export class NodeHost implements Host {
  readonly workspaceName: string;
  readonly policy: HostPolicy;
  private readonly autoConfirm: boolean;
  private readonly logger: (line: string) => void;
  private readonly defaultEncoding: string;
  private readonly defaultEol: "lf" | "crlf";
  private readonly fallbackEncoding: string;
  readonly index: WorkspaceIndex;

  constructor(
    readonly rootPath: string,
    opts: NodeHostOptions = {},
  ) {
    this.rootPath = path.resolve(rootPath);
    this.workspaceName = path.basename(this.rootPath);
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.autoConfirm = opts.autoConfirm ?? false;
    this.logger = opts.log ?? ((l) => console.log(l));
    this.defaultEncoding = opts.defaultEncoding ?? "utf8";
    this.defaultEol = opts.defaultEol ?? "lf";
    this.fallbackEncoding = opts.fallbackEncoding ?? "windows-1250";
    this.index = new WorkspaceIndex({
      roots: [{ name: this.workspaceName, fsPath: this.rootPath }],
      fallbackEncoding: () => this.fallbackEncoding,
      storageFile: opts.indexFile,
      maxAgeMs: opts.indexMaxAgeMs ?? 0,
    });
  }

  get folders(): { name: string; path: string }[] {
    return [{ name: this.workspaceName, path: this.rootPath }];
  }

  private roots(): RootFolder[] {
    return [{ name: this.workspaceName, fsPath: this.rootPath }];
  }

  /** Stejný překlad cest jako v rozšíření: relativní, `~/.copy-agent/…`, absolutní uvnitř workspace. */
  private abs(rel: string): string {
    return resolveRel(rel, this.roots()).fsPath;
  }

  assertInside(rel: string): void {
    resolveRel(rel, this.roots());
  }

  canonical(rel: string): string {
    return canonicalRel(rel, this.roots());
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(rel: string): Promise<string> {
    const buf = await fs.readFile(this.abs(rel));
    return toLf(decodeBytes(buf, detectEncoding(buf, this.fallbackEncoding).encoding));
  }

  async fileEncoding(rel: string): Promise<FileEncoding> {
    try {
      return detectEncoding(await fs.readFile(this.abs(rel)), this.fallbackEncoding);
    } catch {
      return { ...DEFAULT_ENCODING, encoding: normalizeEncoding(this.defaultEncoding), eol: this.defaultEol };
    }
  }

  async writeFile(rel: string, text: string): Promise<void> {
    const p = this.abs(rel);
    const enc = await this.fileEncoding(rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, encodeText(applyEol(text, enc.eol), enc));
    this.index.touch(p);
  }

  async appendFile(rel: string, text: string): Promise<void> {
    const p = this.abs(rel);
    const enc = await this.fileEncoding(rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, encodeText(applyEol(text, enc.eol), { ...enc, bom: false }));
    this.index.touch(p);
  }

  async deleteFile(rel: string): Promise<void> {
    const p = this.abs(rel);
    await fs.rm(p, { force: true });
    this.index.touch(p);
  }

  async moveFile(from: string, to: string): Promise<void> {
    const src = this.abs(from);
    const dest = this.abs(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    this.index.touch(src);
    this.index.touch(dest);
  }

  /** Soubory podle globu, seřazené; jde z indexu (ten si disk projde jen při změně). */
  listFiles(glob: string, max = 5000): Promise<string[]> {
    return this.index.match(glob, max);
  }

  async run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult> {
    const cwd = cwdRel && cwdRel !== "." ? this.abs(cwdRel) : this.rootPath;
    try {
      return await spawnCommand(command, cwd, timeoutMs, probeMs, signal, workspaceEnv([this.rootPath]));
    } finally {
      // příkaz mohl soubory vytvořit, změnit i smazat
      this.index.markStale();
    }
  }
  async diagnostics(): Promise<string> {
    return "";
  }

  /** Bez editoru není na co čekat. */
  async diagnosticsSettled(): Promise<string> {
    return "";
  }

  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }> {
    return captureScreenshot(this.abs(rel), opts);
  }

  absolutePath(rel: string): string {
    return this.abs(rel);
  }

  async confirmCommand(command: string): Promise<boolean> {
    if (this.autoConfirm) this.logger(`[auto-approved command] ${command}`);
    return this.autoConfirm;
  }

  async confirmDelete(rel: string): Promise<boolean> {
    if (this.autoConfirm) this.logger(`[auto-approved delete] ${rel}`);
    return this.autoConfirm;
  }

  log(line: string): void {
    this.logger(line);
  }
}
