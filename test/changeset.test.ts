import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/engine/SessionData";
import { TurnEngine } from "../src/engine/TurnEngine";
import { NodeHost } from "../src/host/NodeHost";
import { buildAgentHeader, buildAgentInstructions, buildPreamble, DEFAULT_OPTIONS } from "../src/protocol/prompt";
import { applyRevert, buildAgentData, buildManifest, changedRanges, mapRange, type ChangeNote, type PendingFile } from "../src/review/changeset";

const V0 = ["begin", "  a := 1;", "  b := 2;", "  c := 3;", "  d := 4;", "end;", ""].join("\n");
const V1 = V0.replace("  a := 1;", "  a := 10;\n  a2 := 11;"); // akce 1: řádky 2-3
const V2 = V1.replace("  d := 4;\n", ""); // akce 2: smazání řádku
const V3 = V2.replace("begin", "-- hlavička\nbegin"); // akce 3: vložení na začátek posune vše o řádek

describe("sada změn pro Review změn", () => {
  it("rozsahy, které akce změnila, a jejich přepočet na pozdější znění", () => {
    expect(changedRanges(V0, V1)).toEqual([{ od: 2, do: 3 }]);
    expect(changedRanges(V1, V2)).toEqual([{ od: 5, do: 6 }]); // čisté smazání: řádky kolem něj
    expect(changedRanges("", "x\ny\n")).toEqual([{ od: 1, do: 2 }]);
    expect(mapRange({ od: 2, do: 3 }, V1, V3)).toEqual({ od: 3, do: 4 });
    expect(mapRange({ od: 2, do: 3 }, V1, V1)).toEqual({ od: 2, do: 3 });
    // řádky později smazané z rozsahu vypadnou; když nezbude nic, rozsah zanikne
    expect(mapRange({ od: 4, do: 6 }, V1, V2)).toEqual({ od: 4, do: 5 });
    expect(mapRange({ od: 6, do: 6 }, V1, V2)).toBeUndefined();
    // řádek později přepsaný patří novému znění
    expect(mapRange({ od: 2, do: 2 }, V1, V1.replace("  a := 10;", "  a := 100;"))).toEqual({ od: 2, do: 2 });
  });

  it("z popisů modelu skládá kusy a kroky plánu v aktuálním znění souborů", () => {
    const note = (o: Partial<ChangeNote>): ChangeNote => ({ path: "src/a.sql", turn: 1, kind: "modify", before: "", after: "", title: "", text: "", ...o });
    const notes = [
      note({ before: V0, after: V1, title: "Hodnota a", text: "Desetkrát víc a nová proměnná.", risk: "high", step: "Výpočet" }),
      note({ before: V1, after: V2, title: "Bez d", text: "Proměnná d se nepoužívala.", step: "Úklid" }),
      note({ before: V2, after: V3, title: "Hlavička", text: "Komentář na začátku." }),
      note({ path: "src/novy.sql", kind: "create", before: "", after: "select 1;\nselect 2;\n", title: "Nový skript", text: "Kontrolní dotaz.", risk: "střední", step: "Výpočet" }),
      note({ path: "src/stary.sql", kind: "delete", before: "x\ny\nz\n", after: "", title: "Starý skript", text: "Už se nevolá." }),
      note({ path: "src/prijato.sql", before: "a", after: "b", title: "Už přijatá změna", text: "" }),
    ];
    const files: PendingFile[] = [
      { path: "src/a.sql", abs: "/ws/src/a.sql", kind: "modify", baseline: V0, live: V3 },
      { path: "src/novy.sql", abs: "/ws/src/novy.sql", kind: "create", baseline: "", live: "select 1;\nselect 2;\nselect 3;\n" },
      { path: "src/stary.sql", abs: "/ws/src/stary.sql", kind: "delete", baseline: "x\ny\nz\n" },
    ];
    const data = buildAgentData(notes, files, "Úprava výpočtu\ndruhý řádek zadání")!;
    expect(data.souhrn).toEqual({ titulek: "Úprava výpočtu" });
    const kusy = data.kusy as Record<string, unknown>[];
    const by = (id: string) => kusy.find((k) => k.id === id)!;
    expect(by("n1")).toMatchObject({ soubor: "/ws/src/a.sql", radky: { od: 3, do: 4 }, titulek: "Hodnota a", popis: "Desetkrát víc a nová proměnná.", riziko: { uroven: "vysoke", duvod: "" } });
    expect(by("n2")).toMatchObject({ radky: { od: 6, do: 7 }, titulek: "Bez d" });
    expect(by("n2").riziko).toBeUndefined();
    expect(by("n3")).toMatchObject({ radky: { od: 1, do: 1 }, titulek: "Hlavička" });
    expect(by("n4")).toMatchObject({ soubor: "/ws/src/novy.sql", radky: { od: 1, do: 2 }, riziko: { uroven: "stredni", duvod: "" } });
    expect(by("n5")).toMatchObject({ soubor: "/ws/src/stary.sql", stare: { od: 1, do: 3 }, titulek: "Starý skript" });
    expect(kusy.map((k) => k.id)).toEqual(["n5", "n4", "n3", "n2", "n1"]); // novější první
    expect(data.plan).toEqual([{ krok: 1, nazev: "Výpočet", kusy: ["n1", "n4"] }, { krok: 2, nazev: "Úklid", kusy: ["n2"] }, { krok: 3, nazev: "Další změny", kusy: ["n3", "n5"] }]);
    // bez kroků není plán; bez popisů nejsou data
    expect((buildAgentData([note({ before: V0, after: V1, title: "x", text: "y" })], [files[0]], "t") as { plan: unknown[] }).plan).toEqual([]);
    expect(buildAgentData([], files, "t")).toBeNull();
    // řádky, které pozdější akce celé přepsala, dostane její popis; starší popis bez řádků zmizí
    const again = buildAgentData([note({ before: V0, after: V1, title: "První", text: "" }), note({ before: V1, after: V1.replace("  a := 10;\n  a2 := 11;", "  a := 0;"), title: "Druhá", text: "" })],
      [{ path: "src/a.sql", abs: "/ws/src/a.sql", kind: "modify", baseline: V0, live: V1.replace("  a := 10;\n  a2 := 11;", "  a := 0;") }], "t") as { kusy: { titulek: string }[] };
    expect(again.kusy.map((k) => k.titulek)).toEqual(["Druhá"]);
  });

  it("soubor sady: stav souborů a znění před změnou", () => {
    const { manifest, bases } = buildManifest([
      { path: "src/a.sql", abs: "/ws/src/a.sql", kind: "modify", baseline: V0, live: V1 },
      { path: "src/novy.sql", abs: "/ws/src/novy.sql", kind: "create", baseline: "", live: "x" },
      { path: "lib/a.sql", abs: "/ws/lib/a.sql", kind: "delete", baseline: "pryč\n" },
    ], "Úkol pro agenta");
    expect(manifest).toMatchObject({ verze: 1, nazev: "Copy Agent: Úkol pro agenta", puvod: "copy-agent", prikazy: { prijmout: "copyAgent.review.acceptAll", zamitnout: "copyAgent.review.revert" } });
    expect(manifest.soubory).toEqual([
      { soubor: "/ws/src/a.sql", stav: "upraven", puvodni: "base/1-a.sql" }, { soubor: "/ws/src/novy.sql", stav: "pridan" }, { soubor: "/ws/lib/a.sql", stav: "smazan", puvodni: "base/3-a.sql" },
    ]);
    expect(bases).toEqual([{ name: "base/1-a.sql", content: V0 }, { name: "base/3-a.sql", content: "pryč\n" }]);
  });

  it("vrátí zamítnuté řádky do souboru", () => {
    // kus = řádky 2-3 nového znění místo původního řádku 2
    expect(applyRevert(V1, [{ radek: 2, odebrat: 2, vlozit: ["  a := 1;"] }])).toBe(V0);
    // smazání: vložit původní řádek zpět
    expect(applyRevert(V2, [{ radek: 6, odebrat: 0, vlozit: ["  d := 4;"] }])).toBe(V1);
    // více úprav v jednom souboru se počítá proti stejnému znění
    expect(applyRevert(V3, [{ radek: 1, odebrat: 1, vlozit: [] }, { radek: 7, odebrat: 0, vlozit: ["  d := 4;"] }])).toBe(V1);
    expect(applyRevert("a\r\nB\r\n", [{ radek: 2, odebrat: 1, vlozit: ["b"] }])).toBe("a\nb\n");
  });

  it("model popíše změny rovnou v odpovědi: <change> se váže na akci před sebou", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-notes-"));
    fs.writeFileSync(path.join(dir, "a.sql"), V0);
    fs.writeFileSync(path.join(dir, "stary.sql"), "x\n");
    const notes: ChangeNote[] = [];
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    const engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", describeChanges: true },
      { onWillChange: () => undefined, onWillDelete: () => undefined, onNote: (n) => notes.push(n) });
    const session = createSession("úkol");
    const reply = [
      '<copy turn="1">',
      '<change title="Bez předchozí změny">nemá se k čemu přiřadit</change>',
      '<edit path="a.sql">', "<<<<<<< SEARCH", "  a := 1;", "=======", "  a := 10;", "  a2 := 11;", ">>>>>>> REPLACE", "</edit>",
      '<change title="Hodnota a" risk="high" step="Výpočet">Desetkrát víc a nová proměnná.</change>',
      '<write path="novy.sql">', "select 1;", "</write>",
      '<change title="Nový skript" step="Výpočet">Kontrolní dotaz.</change>',
      '<delete path="stary.sql"/>',
      '<change title="Starý skript">Už se nevolá.</change>',
      "<done>Hotovo.</done>",
      "</copy>",
    ].join("\n");
    const step = await engine.execute(session, engine.parse(reply), 100);
    expect(step.kind).toBe("done");
    expect(notes.map((n) => [n.path, n.kind, n.title, n.risk, n.step, n.text])).toEqual([
      ["a.sql", "modify", "Hodnota a", "high", "Výpočet", "Desetkrát víc a nová proměnná."],
      ["novy.sql", "create", "Nový skript", undefined, "Výpočet", "Kontrolní dotaz."],
      ["stary.sql", "delete", "Starý skript", undefined, undefined, "Už se nevolá."],
    ]);
    expect(notes[0].before).toBe(V0);
    expect(notes[0].after).toBe(V1);
    expect(notes.every((n) => n.turn === 1)).toBe(true);
    // z popisů jsou rovnou data pro Review změn
    const live = (p: string) => fs.readFileSync(path.join(dir, p), "utf8");
    const data = buildAgentData(notes, [
      { path: "a.sql", abs: path.join(dir, "a.sql"), kind: "modify", baseline: V0, live: live("a.sql") },
      { path: "novy.sql", abs: path.join(dir, "novy.sql"), kind: "create", baseline: "", live: live("novy.sql") },
      { path: "stary.sql", abs: path.join(dir, "stary.sql"), kind: "delete", baseline: "x\n" },
    ], "úkol") as { kusy: { id: string; radky?: unknown; stare?: unknown }[]; plan: unknown[] };
    expect(data.kusy.map((k) => [k.id, k.radky ?? k.stare])).toEqual([["n3", { od: 1, do: 1 }], ["n2", { od: 1, do: 1 }], ["n1", { od: 2, do: 3 }]]);
    expect(data.plan).toEqual([{ krok: 1, nazev: "Výpočet", kusy: ["n1", "n2"] }, { krok: 2, nazev: "Další změny", kusy: ["n3"] }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pokyn k popisům jde do úkolu jen se zapnutou volbou; instrukce agenta se vejdou do limitu", () => {
    const ctx = { workspaceName: "p", tree: "a.sql" };
    expect(buildAgentHeader(ctx, { ...DEFAULT_OPTIONS, describeChanges: true })).toContain("CHANGE NOTES are ON: right after every <write>, <edit>, <move> and <delete> add <change title=");
    expect(buildAgentHeader(ctx, DEFAULT_OPTIONS)).not.toContain("CHANGE NOTES are ON");
    expect(buildPreamble(ctx, { ...DEFAULT_OPTIONS, target: "generic", describeChanges: true })).toContain("CHANGE NOTES are ON");
    const instructions = buildAgentInstructions();
    expect(instructions).toContain("<change ");
    expect(instructions).not.toContain("CHANGE NOTES are ON:");
    expect(instructions.length).toBeLessThanOrEqual(8000);
  });

  it("model si umí vyžádat pokyny skillu akcí <skill>, i když ji napíše jako párový tag", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-skill-"));
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    const skills = [{ name: "review-plan", body: "Prepare the review data.\n\n## Scripts shipped with this skill\n- `python review_data.py`\n" + "x".repeat(9000) }, { name: "prazdny" }];
    const engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off", skills: () => skills });
    const session = createSession("udělej review commitů NIP-1");
    const parsed = engine.parse('<copy turn="1">\n<skill name="review-plan" args="--review --message NIP-1"/>\n<skill name="/Review-Plan">--commits r12</skill>\n<skill name="neni"/>\n<status>čtu pokyny</status>\n</copy>');
    expect(parsed.errors).toEqual([]);
    expect(parsed.actions.map((a) => [a.tool, a.attrs.name, a.attrs.args])).toEqual([["skill", "review-plan", "--review --message NIP-1"], ["skill", "/Review-Plan", "--commits r12"], ["skill", "neni", undefined], ["status", undefined, undefined]]);
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      const [a, b, c] = step.record.results;
      expect(a.status).toBe("ok");
      expect(a.output).toContain("Instructions of the skill /review-plan. Follow them now, as if the user had written: /review-plan --review --message NIP-1");
      expect(b.output).toContain("as if the user had written: /review-plan --commits r12");
      expect(c).toMatchObject({ status: "error", output: 'Unknown skill "neni". Available: /review-plan.' });
      // pokyny jdou modelu celé, nezkrácené jako výstup příkazu
      expect(step.prompt).toContain("## Scripts shipped with this skill");
      expect(step.prompt).toContain("x".repeat(9000));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
