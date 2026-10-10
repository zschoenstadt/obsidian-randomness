import { Evaluator, EvaluatorOptions, RecursionLimitError } from "../../src/engine/evaluator";
import { parseGeneratorFile } from "../../src/engine/fileParser";
import { createQueryTableSource, QueryTableOptions } from "../../src/resolver/queryTables";
import { matchesTagRollFilter } from "../../src/resolver/mdContent";

type Note = { tags: string[]; properties: Record<string, unknown>; body?: string };

function fixture(notes: Record<string, Note> = {
    "A.md": { tags: ["spell"], properties: { level: 1, region: "North" } },
    "B.md": { tags: ["spell"], properties: { level: 2, region: "North" } },
    "C.md": { tags: ["spell"], properties: { level: 1, region: "South" } },
    "D.md": { tags: ["spell"], properties: { level: 2, region: "South" } },
}) {
    const files = jest.fn((filter: Parameters<typeof matchesTagRollFilter>[2]) =>
        Object.keys(notes).sort().filter((path) =>
            matchesTagRollFilter(new Set(notes[path].tags), notes[path].properties, filter, path)
        )
    );
    const read = jest.fn(async (path: string) => notes[path]?.body ?? null);
    const create = (text: string, opts: EvaluatorOptions = {}, overrides: Partial<QueryTableOptions> = {}) => {
        const main = parseGeneratorFile(text);
        const source = createQueryTableSource({ main, extras: [], loadedPaths: [] }, {
            files, frontmatter: (path) => notes[path]?.properties, seed: 7,
            source: { read, exists: async (path) => path in notes }, ...overrides,
        });
        const load = jest.spyOn(source, "load");
        const clear = jest.spyOn(source, "clear");
        return { evaluator: new Evaluator(main, [], { seed: 7, ...opts, tableSource: source }), load, clear, main };
    };
    return { create, files, read, notes };
}

const SPELLS = "QueryTable: Spells=#spell|level={$level}|prop:level";

describe("variable-bound QueryTable instances", () => {
    test("level 1 -> 2 -> 1 uses two instances and reuses the earlier rows", async () => {
        const h = fixture();
        const { evaluator, load } = h.create("Table: Main\n{level==1}[@Spells] / {level==2}[@Spells] / {level==1}[@Spells]\n" + SPELLS);
        expect(await evaluator.runAsync()).toBe("1 / 2 / 1");
        expect(h.files).toHaveBeenCalledTimes(2);
        expect(load.mock.calls.filter(([, query]) => query).map(([, , bindings]) => bindings))
            .toEqual([{ level: "1" }, { level: "2" }]);
        expect(h.read).not.toHaveBeenCalled();
    });

    test("unrelated and output-only changes do not create instances", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Table: Main\n{level==1}{label=='old'}[@Spells] / {unrelated==99}{label=='new'}[@Spells]\n" +
            "QueryTable: Spells=#spell|level={$level}|prop:{{level}} {$label}"
        );
        expect(await evaluator.runAsync()).toBe("1 old / 1 new");
        expect(h.files).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0][2]).toEqual({ level: "1" });
    });

    test("the key contains only relevant bindings and normalizes number/text field values", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Table: Main\n{level==1}{region=='North'}[@Spells] / " +
            "{region=='South'}[@Spells] / {level=='1'}{region=='North'}[@Spells]\n" +
            "QueryTable: Spells=#spell|level={$level}|region={$region}|prop:{{name}}"
        );
        expect(await evaluator.runAsync()).toBe("A / C / A");
        expect(load).toHaveBeenCalledTimes(2);
        expect(load.mock.calls.map(([, , bindings]) => bindings)).toEqual([
            { level: "1", region: "North" }, { level: "1", region: "South" },
        ]);
    });

    test("query definitions stay immutable and separate named declarations keep their own instances", async () => {
        const h = fixture();
        const { evaluator, main, load } = h.create(
            "Table: Main\n{level==1}[@Spells] [@Other] {level==2}[@Spells]\n" +
            SPELLS + "\nQueryTable: Other=#spell|level={$level}|prop:{{name}}"
        );
        const before = JSON.stringify(main);
        expect(await evaluator.runAsync()).toMatch(/^1 [AC] 2$/);
        expect(h.files).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(main)).toBe(before);
    });

    test("file-wide and table Set directives retain last-assignment-wins ordering", async () => {
        const h = fixture();
        expect(await h.create(
            "Set: level=1\nSet: level=2\nTable: Main\n[@Spells]\n" + SPELLS
        ).evaluator.runAsync()).toBe("2");
        h.files.mockClear();
        expect(await h.create(
            "Table: Main\nSet: level=1\n[@Spells]\nSet: level=2\n" + SPELLS
        ).evaluator.runAsync()).toBe("2");
        expect(h.files.mock.calls[0][0].props).toEqual([{ key: "level", values: ["2"] }]);
    });

    test("helper-table assignments and repetitions can change the next query invocation", async () => {
        const h = fixture();
        expect(await h.create(
            "Table: Main\n{level==1}[@Spells] [@Change] [@Spells]\n" +
            "Table: Change\nSet: level=2\nchanged\n" + SPELLS
        ).evaluator.runAsync()).toBe("1 changed 2");
        expect(await h.create(
            "Table: Main\n{level==1}[@2 Spells >> implode]\n" +
            "QueryTable: Spells=#spell|level={$level}|prop:{{level}}{level==level+1}"
        ).evaluator.runAsync()).toBe("1, 2");
    });

    test("query table assignments precede ordinary rolls but not count, indexed picks or draws", async () => {
        const h = fixture();
        const { evaluator } = h.create(
            "Table: Main\n{level==1}{count(Spells)} [#1 Spells] [!Spells] [@Spells]\n" +
            SPELLS + "\nSet: level=2"
        );
        expect(await evaluator.runAsync()).toBe("2 1 1 2");
    });

    test.each(["[@Spells with 2]", "[#1 Spells with 2]", "[!Spells with 2]", "{[@Spells with 2]+1}"])(
        "parameters are established before selection and restored: %s", async (call) => {
            const h = fixture();
            const { evaluator, load } = h.create(
                "Table: Main\n" + call + "|{$1}\nQueryTable: Spells=#spell|level={$1}|prop:level"
            );
            expect(await evaluator.runAsync()).toBe(call.startsWith("{") ? "3|" : "2|");
            expect(load.mock.calls[0][2]).toEqual({ "1": "2" });
        }
    );

    test("nested parameters and filter each use the current call's bindings", async () => {
        const h = fixture();
        expect(await h.create(
            "Table: Main\n[@Helper with 1] / [2 >> each Spells]\n" +
            "Table: Helper\n[@Spells with 2] {$1} [@Spells]\n" +
            "QueryTable: Spells=#spell|level={$1}|prop:level"
        ).evaluator.runAsync()).toBe("2 1 1 / 2");
    });

    test("resolve duplicate references once and do not evaluate unused definitions", async () => {
        const h = fixture();
        const dice: number[] = [];
        const { evaluator, load } = h.create(
            "Define: Level={1d1}\nDefine: unused=[@Missing]\nTable: Main\n[@Spells] {count(Spells)}\n" +
            "QueryTable: Spells=#spell|level={$level}|level={LEVEL}|prop:level",
            { onDice: (entry) => dice.push(entry.total) }
        );
        expect(await evaluator.runAsync()).toBe("1 2");
        expect(dice).toEqual([1, 1]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0][2]).toEqual({ level: "1" });
    });

    test("a lazy definition follows its current resolved value without a dependency graph", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Define: level={$base}\nTable: Main\n{base==1}[@Spells] {base==2}[@Spells] {base==1}[@Spells]\n" + SPELLS
        );
        expect(await evaluator.runAsync()).toBe("1 2 1");
        expect(load).toHaveBeenCalledTimes(2);
    });

    test("case variants of a definition refer to one variable with the latest assigned value", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Define: LEVEL=1\nDefine: level=2\nDefine: LEVEL=1\nTable: Main\n{$LeVeL} [@Spells]\n" + SPELLS
        );
        expect(await evaluator.runAsync()).toBe("1 1");
        expect(load.mock.calls[0][2]).toEqual({ level: "1" });
    });

    test("query assignment failures restore positional parameters", async () => {
        const h = fixture();
        const { evaluator, clear } = h.create(
            "Table: Main\n[@Spells with 2]\n" +
            "QueryTable: Spells=#spell|level={$1}|prop:level\nSet: checked=[@Missing]"
        );
        await expect(evaluator.runAsync()).rejects.toThrow("Unknown table: Missing");
        expect(await evaluator.evalRawTextAsync("<{$1}>")).toBe("<>");
        expect(h.files).not.toHaveBeenCalled();
        expect(clear).toHaveBeenCalledTimes(2);
    });

    test("count uses current bindings without executing query table assignments", async () => {
        const h = fixture();
        const { evaluator } = h.create(
            "Table: Main\n{level==1}{count(Spells)} {level==3}{count(Spells)}\n" +
            SPELLS + "\nSet: forbidden=[@Missing]"
        );
        expect(await evaluator.runAsync()).toBe("2 0");
        expect(h.files).toHaveBeenCalledTimes(2);
    });

    test("variables in ignored controls never resolve or split the instance", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Table: Main\n{level==1}[@Spells] {unused==2}[@Spells]\n" +
            "QueryTable: Spells={$unused}#spell|level={$level}|unique|sep:{$other}|prop:level"
        );
        expect(await evaluator.runAsync()).toBe("1 1");
        expect(load.mock.calls.map(([, , bindings]) => bindings)).toEqual([{ level: "1" }]);
    });

    test("session pools resume for an earlier binding set and shuffle resets all instances", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Table: Main\n{level==1}[!2 Spells >> implode] / {level==2}[!2 Spells >> implode] / " +
            "{level==1}[!Spells] / [@Reset] / {level==2}[!Spells]\n" +
            "QueryTable: Spells=#spell|level={$level}|prop:{{name}}\nTable: Reset\nShuffle: Spells\n[!Spells]"
        );
        const parts = (await evaluator.runAsync()).split(" / ");
        expect(new Set(parts[0].split(", "))).toEqual(new Set(["A", "C"]));
        expect(new Set(parts[1].split(", "))).toEqual(new Set(["B", "D"]));
        expect(parts[2]).toBe("");
        expect(["A", "C"]).toContain(parts[3]);
        expect(["B", "D"]).toContain(parts[4]);
        expect(load).toHaveBeenCalledTimes(2);
    });

    test("scope cleanup discards every instance and session pool, including empty results", async () => {
        const h = fixture({ "A.md": { tags: ["spell"], properties: { level: 1 } } });
        const { evaluator, clear } = h.create(SPELLS + "\nDefault: no spell");
        expect(await evaluator.evalRawTextAsync("{level==1}[!Spells] [!Spells] {level==2}[@Spells]")).toBe("1  no spell");
        h.notes["A.md"].properties.level = 2;
        expect(await evaluator.evalRawTextAsync("{level==2}[!Spells]")).toBe("2");
        expect(h.files).toHaveBeenCalledTimes(3);
        expect(clear).toHaveBeenCalledTimes(2);
    });

    test("whole-file repetitions retain per-repetition draw resets for each binding instance", async () => {
        const h = fixture({ "A.md": { tags: ["spell"], properties: { level: 1 } } });
        const { evaluator, load } = h.create(
            "MaxReps: 2\nTable: Main\n{level==1}[!Spells] / [!Spells]\n" + SPELLS
        );
        expect(await evaluator.runAsync()).toBe("1 / \n\n1 / ");
        expect(load).toHaveBeenCalledTimes(1);
    });

    test("failed loads restore parameters and do not cache successful-looking rows", async () => {
        const h = fixture();
        let fail = true;
        const { evaluator, clear } = h.create(
            "Table: Main\n[@Spells with 2]\nQueryTable: Spells=#spell|level={$1}|prop:level", {}, {
                files: (filter) => {
                    if (fail) throw new Error("offline");
                    return h.files(filter);
                },
            }
        );
        await expect(evaluator.runAsync()).rejects.toThrow("QueryTable 'Spells'");
        fail = false;
        expect(await evaluator.evalRawTextAsync("{$1}[@Main]")).toBe("2");
        expect(clear).toHaveBeenCalledTimes(2);
    });

    test.each(["[@Spells]", "{count(Spells)}"])("recursive variable resolution is bounded: %s", async (body) => {
        const h = fixture();
        const { evaluator, clear } = h.create(
            "Define: level=" + body + "\nTable: Main\n[@Spells]\n" + SPELLS,
            { maxRecursionDepth: 8 }
        );
        await expect(evaluator.runAsync()).rejects.toThrow(RecursionLimitError);
        expect(clear).toHaveBeenCalledTimes(1);
        expect(h.files).not.toHaveBeenCalled();
    });

    test("unused queries and unselected branches never resolve their variables", async () => {
        const h = fixture();
        const { evaluator, load } = h.create(
            "Table: Main\n[when]1[do]plain[else][@Unused][end]\n" +
            "QueryTable: Unused=#{$missing}|level={$other}|link"
        );
        expect(await evaluator.runAsync()).toBe("plain");
        expect(load).not.toHaveBeenCalled();
        expect(h.files).not.toHaveBeenCalled();
        expect(h.read).not.toHaveBeenCalled();
    });

    test("many variable instances do not count as distinct query declarations", async () => {
        const notes = Object.fromEntries(Array.from({ length: 70 }, (_, n) => [
            `N${n}.md`, { tags: ["spell"], properties: { level: n } },
        ]));
        const h = fixture(notes);
        const body = Array.from({ length: 70 }, (_, n) => `{level==${n}}[@Spells]`).join("/");
        expect(await h.create("Table: Main\n" + body + "\n" + SPELLS).evaluator.runAsync())
            .toBe(Array.from({ length: 70 }, (_, n) => String(n)).join("/"));
        expect(h.files).toHaveBeenCalledTimes(70);
    });

    test("block instances reuse samples without extra reads or RNG consumption for unrelated changes", async () => {
        const notes = Object.fromEntries(Array.from({ length: 140 }, (_, n) => [
            `N${n}.md`, { tags: ["spell"], properties: { level: n % 2 + 1 }, body: `Block ${n}` },
        ]));
        const h = fixture(notes);
        const base = "Table: Main\n{level==1}[@Spells] {level==2}[@Spells] {level==1}[@Spells]\nQueryTable: Spells=#spell|level={$level}";
        const changed = base.replace("{level==2}", "{unrelated==99}{level==2}");
        const first = await h.create(base).evaluator.runAsync();
        expect(h.files).toHaveBeenCalledTimes(2);
        expect(h.read.mock.calls.length).toBeLessThanOrEqual(3);
        expect(await h.create(changed).evaluator.runAsync()).toBe(first);
    });
});
