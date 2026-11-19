import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_EXCLUDES, parseGitignoreNames } from "../protocol/text";
import { canonicalRel, splitGlob } from "../protocol/roots";
import type { WorkspaceIndex } from "../index/WorkspaceIndex";
import { ApprovalService } from "../safety/Approvals";
import { FileEncoding } from "../tools/encoding";
import { cfg, CONFIG, fileEncodingOf, fileExists, readText, resolveInWorkspace, tryToRel, workspaceFolders, workspaceName, workspaceRoot, writeText } from "../util";
import { Host, HostPolicy, RunResult } from "./Host";
import { captureScreenshot } from "./screenshot";
import { spawnCommand, workspaceEnv } from "./spawn";

const SEV = ["error", "warning", "info", "hint"];

/** Host nad VS Code API. Čte konfiguraci copyAgent.* při každém dotazu; schvalování jde přes ApprovalService. */
export class VsCodeHost implements Host {
  /** cache seznamu souborů (findFiles je drahé): obnova nejvýš po 3 s nebo při změně souborů */
  private filesCache: { at: number; key: string; list: string[] } | undefined;
  private readonly watcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly approvals: ApprovalService,
    /** index workspace (sdílený, žije déle než host); bez něj se soubory hledají přes findFiles */
    private readonly indexOf: () => WorkspaceIndex | undefined = () => undefined,
  ) {
    if (!this.indexOf()) {
      this.watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
      const invalidate = () => (this.filesCache = undefined);
      this.watcher.onDidCreate(invalidate);
      this.watcher.onDidDelete(invalidate);
    }
  }

  get index(): WorkspaceIndex | undefined {
    return this.indexOf();
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  get workspaceName(): string {
    return workspaceName();
  }

  get policy(): HostPolicy {
    const insp = vscode.workspace.getConfiguration(CONFIG).inspect<string[]>("run.allowPatterns");
    const allowPatterns = [...new Set([...(insp?.globalValue ?? []), ...(insp?.workspaceValue ?? []), ...(insp?.workspaceFolderValue ?? [])])];
    return { autoAllow: cfg<string[]>("run.autoAllow", []), allowPatterns, deny: cfg<string[]>("run.deny", []), protectedPaths: cfg<string[]>("protectedPaths", []), powershellNoProfile: cfg<boolean>("run.powershellNoProfile", true) };
  }

  assertInside(rel: string): void {
    resolveInWorkspace(rel);
  }

  canonical(rel: string): string {
    return canonicalRel(rel, workspaceFolders());
  }

  /** Nikdy nevyhazuje: cesta, kterou nejde přeložit (mimo workspace, holá v multi-root), prostě neexistuje. */
  async exists(rel: string): Promise<boolean> {
    try {
      return await fileExists(resolveInWorkspace(rel));
    } catch {
      return false;
    }
  }

  readFile(rel: string): Promise<string> {
    return readText(resolveInWorkspace(rel));
  }

  fileEncoding(rel: string): Promise<FileEncoding> {
    return fileEncodingOf(resolveInWorkspace(rel));
  }

  // Vlastní zápisy se indexu hlásí hned: sledování souborů je hlásí taky, ale se zpožděním, a další
  // akce téhož bloku (hledání, výpis) už musí vidět nový stav.
  async writeFile(rel: string, text: string): Promise<void> {
    const uri = resolveInWorkspace(rel);
    await writeText(uri, text);
    this.index?.touch(uri.fsPath);
  }

  async appendFile(rel: string, text: string): Promise<void> {
    const uri = resolveInWorkspace(rel);
    const current = (await fileExists(uri)) ? await readText(uri) : "";
    await writeText(uri, current + text);
    this.index?.touch(uri.fsPath);
  }

  async deleteFile(rel: string): Promise<void> {
    const uri = resolveInWorkspace(rel);
    await vscode.workspace.fs.delete(uri);
    this.index?.touch(uri.fsPath);
  }

  async moveFile(from: string, to: string): Promise<void> {
    const src = resolveInWorkspace(from);
    const dest = resolveInWorkspace(to);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dest.fsPath)));
    await vscode.workspace.fs.rename(src, dest, { overwrite: false });
    this.index?.touch(src.fsPath);
    this.index?.touch(dest.fsPath);
  }

  get folders(): { name: string; path: string }[] {
    return workspaceFolders().map((f) => ({ name: f.name, path: f.fsPath }));
  }

  /** Soubory ve všech složkách workspace; úplný seznam je v cache, globy se filtrují lokálně. */
  async listFiles(glob: string, max = 5000): Promise<string[]> {
    const index = this.index;
    if (index) return index.match(glob, max);
    const all = await this.allFiles();
    if (glob === "**/*" || glob === "**") return all.slice(0, max);
    const { globToRegExp } = await import("../protocol/text");
    const out: string[] = [];
    for (const { folder, glob: g } of splitGlob(glob, workspaceFolders())) {
      const re = globToRegExp(g);
      const prefix = workspaceFolders().length > 1 ? `${folder.name}/` : "";
      for (const f of all) {
        if (prefix && !f.startsWith(prefix)) continue;
        const inner = prefix ? f.slice(prefix.length) : f;
        if (re.test(inner)) out.push(f);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  private async allFiles(): Promise<string[]> {
    const key = workspaceFolders().map((f) => f.fsPath).join(";");
    if (this.filesCache && this.filesCache.key === key && Date.now() - this.filesCache.at < 3000) return this.filesCache.list;
    const out: string[] = [];
    for (const folder of workspaceFolders()) {
      const names = new Set(DEFAULT_EXCLUDES);
      try {
        parseGitignoreNames(await readText(vscode.Uri.joinPath(vscode.Uri.file(folder.fsPath), ".gitignore"))).forEach((n) => names.add(n));
      } catch {
        /* bez .gitignore */
      }
      const exclude = `{${[...names].map((n) => `**/${n}/**,**/${n}`).join(",")}}`;
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(folder.fsPath), "**/*"), exclude, 20000);
      for (const u of uris) {
        const rel = tryToRel(u);
        if (rel) out.push(rel);
      }
    }
    out.sort();
    this.filesCache = { at: Date.now(), key, list: out };
    return out;
  }

  async run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult> {
    const cwd = cwdRel && cwdRel !== "." ? resolveInWorkspace(cwdRel).fsPath : workspaceRoot().fsPath;
    const wsFile = vscode.workspace.workspaceFile?.scheme === "file" ? vscode.workspace.workspaceFile.fsPath : undefined;
    try {
      return await spawnCommand(command, cwd, timeoutMs, probeMs, signal, workspaceEnv(workspaceFolders().map((f) => f.fsPath), wsFile));
    } finally {
      // příkaz mohl soubory vytvořit, změnit i smazat: změny hlásí sledování souborů (další dotaz na ně
      // chvilku počká); celý disk se pro jistotu projde jen na pozadí
      this.index?.settle(300);
      this.index?.refreshInBackground();
    }
  }

  async diagnostics(onlyRel?: string, maxLines = 60): Promise<string> {
    const only = onlyRel ? resolveInWorkspace(onlyRel).fsPath.toLowerCase() : null;
    const lines: string[] = [];
    let total = 0;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const rel = tryToRel(uri);
      if (!rel) continue;
      if (only && uri.fsPath.toLowerCase() !== only) continue;
      if (/[\\/](node_modules|\.git|dist|out)[\\/]/.test(uri.fsPath)) continue;
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        total++;
        if (lines.length >= maxLines) continue;
        const code = typeof d.code === "object" ? d.code.value : d.code;
        lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEV[d.severity]}${code ? ` ${code}` : ""}: ${d.message.split("\n")[0]}`);
      }
    }
    if (total > lines.length) lines.push(`… (${total - lines.length} more)`);
    return lines.join("\n");
  }

  /**
   * Diagnostika po změně souborů. Místo pevného čekání sleduje, kdy ji jazykové servery přepočítají:
   * skončí 300 ms po poslední změně diagnostiky, hned po 800 ms, když se neozval žádný server
   * (soubory bez jazykového serveru, např. SQL), a nejpozději za 2,5 s.
   */
  async diagnosticsSettled(onlyRel?: string): Promise<string> {
    await new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      let seen = false;
      const timers: NodeJS.Timeout[] = [];
      const done = () => {
        sub.dispose();
        for (const t of timers) clearTimeout(t);
        if (quiet) clearTimeout(quiet);
        resolve();
      };
      const sub = vscode.languages.onDidChangeDiagnostics(() => {
        seen = true;
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(done, 300);
      });
      timers.push(setTimeout(done, 2500));
      timers.push(setTimeout(() => !seen && done(), 800));
    });
    return this.diagnostics(onlyRel);
  }

  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }> {
    return captureScreenshot(resolveInWorkspace(rel).fsPath, opts);
  }

  absolutePath(rel: string): string {
    return resolveInWorkspace(rel).fsPath;
  }

  confirmCommand(command: string, cwdRel: string): Promise<boolean> {
    return this.approvals.request("command", command, cwdRel);
  }

  confirmDelete(rel: string): Promise<boolean> {
    return this.approvals.request("delete", rel);
  }

  log(line: string): void {
    this.output.appendLine(line);
  }
}
