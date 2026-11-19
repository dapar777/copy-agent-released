import { describe, expect, it } from "vitest";
import { detectRuntime, Probe } from "../src/tools/runtime";

/** Falešné příkazy: klíč je celý příkaz, hodnota jeho výstup; neznámý příkaz „neexistuje". */
const probe = (table: Record<string, string>): Probe => async (cmd, args) => table[[cmd, ...args].join(" ")] ?? "";

describe("detectRuntime", () => {
  it("finds Python and Node.js and the command that starts Python", async () => {
    expect(await detectRuntime("win32", probe({ "python --version": "Python 3.12.1\n", "node --version": "v20.11.0\n" }))).toEqual({ platform: "win32", python: { command: "python", version: "3.12.1" }, node: "20.11.0" });
    expect(await detectRuntime("linux", probe({ "python3 --version": "Python 3.10.12", "python --version": "Python 3.10.12" }))).toEqual({ platform: "linux", python: { command: "python3", version: "3.10.12" } });
  });

  it("on Windows skips the Microsoft Store stub and uses the py launcher", async () => {
    const stub = "Python was not found; run without arguments to install from the Microsoft Store";
    const info = await detectRuntime("win32", probe({ "python --version": stub, "py -3 --version": "Python 3.11.4" }));
    expect(info.python).toEqual({ command: "py -3", version: "3.11.4" });
  });

  it("reports nothing when neither is installed, and ignores Python 2", async () => {
    expect(await detectRuntime("win32", probe({ "python --version": "Python 2.7.18" }))).toEqual({ platform: "win32" });
  });
});
