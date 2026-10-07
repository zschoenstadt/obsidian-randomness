import { parseGeneratorFile } from "../../src/engine/fileParser";
import { Evaluator } from "../../src/engine/evaluator";
import { RNG } from "../../src/engine/rng";
import { inMemorySource, parseFileSource, resolveBundle } from "../../src/resolver/fileResolver";
import { parseDirectTagCall, sampleTagFiles, TagRollFilter, TAG_FILE_CAP } from "../../src/resolver/mdContent";
import { nativeQueryItems, parseQueryTableSource } from "../../src/resolver/nativeQuery";
import { prepareQueryTables, QueryTableOptions } from "../../src/resolver/queryTables";
import { buildInlineBundle } from "../../src/resolver/scope";

function harness(
    files: Record<string, string> = {},
    paths = Object.keys(files).sort(),
    metadata: Record<string, Record<string, unknown>> = {}
) {
    const read = jest.fn(async (path: string) => files[path] ?? null);
    const options: QueryTableOptions = {
        source: { read, exists: async (path) => path in files },
        files: jest.fn((_filter: TagRollFilter) => paths),
        frontmatter: (path) => metadata[path],
        seed: 123,
    };
    const prepare = (source: string, overrides: Partial<QueryTableOptions> = {}) =>
        prepareQueryTables({
            main: parseGeneratorFile(source),
            extras: [],
            loadedPaths: ["test.rdm"],
        }, { ...options, ...overrides });
    return { options, read, prepare };
}

describe("QueryTable declarations", () => {
    test("split only the first equals sign and retain declaration order", () => {
        const file = parseGeneratorFile(
            "qUeRyTaBlE : Merchants = #npc|universe=Eldara|link\nTable: Main\n[@Merchants]"
        );
        expect(file.tables.map((table) => table.name)).toEqual(["Merchants", "Main"]);
        expect(file.tables[0].query).toEqual({ source: "#npc|universe=Eldara|link", line: 1 });
        expect(file.tables[0].items).toEqual([]);
    });

    test.each([
        ["QueryTable: Missing", "expected Name=query"],
        ["QueryTable: =#npc", "must not be empty"],
        ["QueryTable: N=", "must not be empty"],
        ["QueryTable: N=#npc\nHandwritten", "handwritten"],
        ["QueryTable: N=#npc\nType: lookup", "weighted"],
        ["QueryTable: N=#npc\nType: dictionary", "weighted"],
        ["QueryTable: N=#npc\nRoll: 1d6", "Roll:"],
        ["QueryTable: N=#npc\nDeck: persistent", "persistent"],
    ])("reject %s", (source, message) => {
        expect(() => parseGeneratorFile(source)).toThrow(message);
    });

    test("accept ordinary metadata and preserve a trailing ampersand on the declaration", () => {
        const file = parseGeneratorFile(
            "QueryTable: N=#npc|prop:{{name}} &\nHidden: yes\nDefault: nobody\n" +
            "Deck: session\nType: weighted\nSet: x=1\nFlip: 50%\nTurn: half\nShuffle: Other\nEndTable:"
        );
        expect(file.tables[0]).toMatchObject({
            hidden: true, defaultValue: "nobody", deckPersistent: false,
            query: { source: "#npc|prop:{{name}} &" }, shuffleTargets: ["Other"],
        });
    });

    test("preserve names and provenance in markdown and imports", () => {
        const md = "```randomness\nQueryTable: People=#npc|link\n```";
        expect(parseFileSource("People.md", md).tables[0].query?.path).toBe("People.md");
        const bundle = resolveBundle("Main.rdm", "Use: People.md\nTable: Main\n[@People]", {
            callerDir: "", source: inMemorySource({ "People.md": md }),
        });
        expect(bundle.extras[0].tables[0].name).toBe("People");
    });

    test.each(["nonsense", "#npc|folder={$place}|link"])(
        "reject unsupported declaration source %s", (source) => {
            expect(() => parseQueryTableSource(source)).toThrow();
        }
    );

    test("retain parsed inline controls without rejecting them", () => {
        expect(parseQueryTableSource("3#npc|unique|sep:;|link")).toMatchObject({
            reps: "3", unique: true, sep: ";", mode: "link",
        });
    });

    test("selection-looking segments after prop remain literal template text", () => {
        expect(parseQueryTableSource("#npc|prop:{{name}}|unique|sep:;").template)
            .toBe("{{name}}|unique|sep:;");
    });

    test("query source preserves URL slashes and pipes in templates", () => {
        const file = parseGeneratorFile("QueryTable: Q=#npc|prop:{{name}} https://example.com/a=b|literal");
        expect(file.tables[0].query?.source).toBe("#npc|prop:{{name}} https://example.com/a=b|literal");
    });

    test("unprepared declarations cannot silently evaluate as empty", () => {
        expect(() => new Evaluator(parseGeneratorFile("QueryTable: N=#npc|link")))
            .toThrow("must be prepared");
    });
});

describe("QueryTable preparation", () => {
    test.each(["link", "linkpath", "prop:{{name}}", "block"])(
        "inline controls do not change %s table rows or seeded selection", async (mode) => {
            const h = harness({ "A.md": "First", "B.md": "Second", "C.md": "Third" });
            const plain = await h.prepare(`Table: Main\n[@Q]\nQueryTable: Q=#npc|${mode}`);
            for (const controls of [
                `3#npc|${mode}`,
                `0#npc|${mode}`,
                `{1d4}#npc|${mode}`,
                `#npc|unique|${mode}`,
                `#npc|sep:;|${mode}`,
                `3#npc|unique|sep:;|${mode}`,
            ]) {
                const decorated = await h.prepare(`Table: Main\n[@Q]\nQueryTable: Q=${controls}`);
                expect(decorated.main.tables[1].items).toEqual(plain.main.tables[1].items);
                expect(decorated.main.tables[1].items).toHaveLength(3);
                for (const seed of [1, 7, 123]) {
                    expect(new Evaluator(decorated.main, decorated.extras, { seed }).run())
                        .toBe(new Evaluator(plain.main, plain.extras, { seed }).run());
                }
            }
        }
    );

    test.each(["-", "-value", "challenge-rating"])("render YAML property %s", async (key) => {
        const h = harness({}, ["A.md"], { "A.md": { [key]: "matched value" } });
        for (const prop of [key, `{{${key}}}`]) {
            const prepared = await h.prepare(`QueryTable: Q=#npc|prop:${prop}`);
            expect(new Evaluator(prepared.main, prepared.extras).run()).toBe("matched value");
        }
    });

    test.each(["#npc|link", "#npc|linkpath", "#npc|prop:rumours", "#npc|prop:{{name}} ({{cr}})"])(
        "preserve inline output and seeded picks for %s", async (query) => {
            const paths = ["A.md", "B.md", "C.md"];
            const fm = Object.fromEntries(paths.map((path) => [
                path, { cr: 3, rumours: ["First rumour", "Second rumour"] },
            ]));
            const h = harness({}, paths, fm);
            const prepared = await h.prepare(`Table: Main\n[@Q]\nQueryTable: Q=${query}`);
            const inline = buildInlineBundle(query, {
                notePath: "note.md", noteSource: "", source: inMemorySource({}),
                tagFiles: h.options.files, tagFrontmatter: h.options.frontmatter,
            });
            expect(prepared.main.tables[1].items).toEqual(inline.main.tables[1].items);
            for (const seed of [1, 7, 123, 999]) {
                expect(new Evaluator(prepared.main, prepared.extras, { seed }).run())
                    .toBe(new Evaluator(inline.main, inline.extras, { seed }).run());
            }
            expect(h.read).not.toHaveBeenCalled();
        }
    );

    test("list properties remain together and interpolated data is not executable syntax", async () => {
        const h = harness({}, ["A.md"], { "A.md": { rumours: ["[@Missing]", "{1d6}"] } });
        const prepared = await h.prepare("QueryTable: Q=#npc|prop:rumours");
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe("[@Missing], {1d6}");
    });

    test("empty query uses ordinary empty/default behavior", async () => {
        const h = harness({}, []);
        const empty = await h.prepare("QueryTable: Q=#npc|link");
        expect(new Evaluator(empty.main).run()).toBe("");
        const fallback = await h.prepare("QueryTable: Q=#npc|link\nDefault: nobody");
        expect(new Evaluator(fallback.main).run()).toBe("nobody");
    });

    test("support indexed picks, assignments, repetitions and session decks", async () => {
        const h = harness({}, ["A.md", "B.md", "C.md"]);
        const prepared = await h.prepare(
            "Table: Main\n[#2 Q] / [@name==Q]{$name} / [!4 Q >> implode]\nQueryTable: Q=#npc|link"
        );
        const result = new Evaluator(prepared.main, prepared.extras, { seed: 7 }).run();
        expect(result).toMatch(/^\[\[B\|B\]\] \/ \[\[[ABC]\|[ABC]\]\] \/ /);
        const draws = result.split(" / ")[2].match(/\[\[[ABC]\|[ABC]\]\]/g);
        expect(draws).toHaveLength(3);
        expect(new Set(draws).size).toBe(3);
    });

    test("do not flatten blocks, and preserve inline seeded block selection", async () => {
        const files = { "A.md": "Only block", "B.md": "First\n\nSecond\n\nThird" };
        const h = harness(files);
        const prepared = await h.prepare("Table: Main\n[@Q]\nQueryTable: Q=#rumour");
        expect(prepared.main.tables[1].items).toHaveLength(2);
        const helpers = prepared.extras.flatMap((file) => file.tables)
            .filter((table) => table.name.startsWith("__queryblock:"));
        expect(helpers.map((table) => table.items.length)).toEqual([1, 3]);
        const inline = buildInlineBundle("#rumour", {
            notePath: "note.md", noteSource: "", source: inMemorySource(files),
            tagFiles: h.options.files,
        });
        for (const seed of [1, 7, 123, 999]) {
            expect(new Evaluator(prepared.main, prepared.extras, { seed }).run())
                .toBe(new Evaluator(inline.main, inline.extras, { seed }).run());
        }
        expect(h.read.mock.calls.filter(([path]) => path === "A.md")).toHaveLength(1);
    });

    test("private block helpers distinguish identical basenames", async () => {
        const h = harness({ "One/Same.md": "One", "Two/Same.md": "Two" });
        const prepared = await h.prepare(
            "Table: Main\n[#1 Q] / [#2 Q]\nQueryTable: Q=#rumour"
        );
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe("One / Two");
    });

    test("cap block candidates at exactly 50, memoize the sample, and preserve inputs", async () => {
        const files = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [
            `Note${String(n).padStart(3, "0")}.md`, `Block ${n}`,
        ]));
        const h = harness(files);
        const main = parseGeneratorFile("QueryTable: A=#rumour\nQueryTable: B=#rumour");
        const input = { main, extras: [], loadedPaths: [] };
        const prepared = await prepareQueryTables(input, h.options);
        expect(prepared.main.tables[0].items).toHaveLength(TAG_FILE_CAP);
        expect(prepared.main.tables[1].items).toEqual(prepared.main.tables[0].items);
        expect(h.options.files).toHaveBeenCalledTimes(1);
        expect(new Set(h.read.mock.calls.map(([path]) => path)).size).toBe(TAG_FILE_CAP);
        expect(h.read).toHaveBeenCalledTimes(TAG_FILE_CAP);
        expect(prepared.loadedPaths.some((path) => path >= "Note050.md")).toBe(true);
        expect(prepared.loadedPaths).toEqual(sampleTagFiles(Object.keys(files).sort(), TAG_FILE_CAP, new RNG(123)));
        expect(main.tables[0].query).toBeDefined();
        expect(main.tables[0].items).toEqual([]);
        expect(prepared.main.tables[0].items.some((item) =>
            item.rawContent.includes("__queryblock:49"))).toBe(true);
        const again = await prepareQueryTables(input, h.options);
        expect(new Evaluator(prepared.main, prepared.extras, { seed: 123 }).run())
            .toBe(new Evaluator(again.main, again.extras, { seed: 123 }).run());
    });

    test("refresh metadata for each new preparation", async () => {
        const metadata = { "A.md": { value: "old" } };
        const h = harness({}, ["A.md"], metadata);
        const first = await h.prepare("QueryTable: Q=#npc|prop:value");
        metadata["A.md"].value = "new";
        const second = await h.prepare("QueryTable: Q=#npc|prop:value");
        expect(new Evaluator(first.main).run()).toBe("old");
        expect(new Evaluator(second.main).run()).toBe("new");
    });

    test("session deck shuffle restores candidates and state does not persist across evaluations", async () => {
        const h = harness({}, ["A.md"]);
        const prepared = await h.prepare(
            "Table: Main\n[!Q] / [!Q] / [@Reset]\nQueryTable: Q=#npc|link\n" +
            "Table: Reset\nShuffle: Q\n[!Q]"
        );
        const expected = "[[A|A]] /  / [[A|A]]";
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe(expected);
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe(expected);
    });

    test("shadowed declarations do not execute their queries", async () => {
        const h = harness({});
        const prepared = await prepareQueryTables({
            main: parseGeneratorFile("Table: Main\n[@Q]\nQueryTable: Q=invalid"),
            extras: [parseGeneratorFile("Table: Q\nwinner")],
            loadedPaths: [],
        }, h.options);
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe("winner");
        expect(h.options.files).not.toHaveBeenCalled();
    });

    test("read and syntax failures include query provenance", async () => {
        const h = harness({}, ["missing.md"]);
        await expect(h.prepare("QueryTable: Q=#rumour")).rejects.toThrow("QueryTable 'Q'");
        await expect(h.prepare("QueryTable: Q=invalid")).rejects.toThrow("line 1");
        await expect(h.prepare("QueryTable: Q=#npc|link", {
            files: () => { throw new Error("metadata unavailable"); },
        })).rejects.toThrow("metadata unavailable");
    });

    test("prepare query tables discovered from a materialized property template", async () => {
        const h = harness({}, ["A.md"]);
        const discover = jest.fn(async () => [
            parseGeneratorFile("QueryTable: Other=#npc|link"),
        ]);
        const prepared = await h.prepare("QueryTable: Q=#npc|prop:{{name}} [@Other]", { discover });
        expect(new Evaluator(prepared.main, prepared.extras).run()).toBe("A [[A|A]]");
        expect(discover).toHaveBeenCalledTimes(2);
    });

    test("load note imports used by block content", async () => {
        const h = harness({
            "A.md": "```randomness\nUse: Helpers.rdm\n```\n\n[@Other]",
            "Helpers.rdm": "Table: Other\nimported",
        }, ["A.md"]);
        const prepared = await h.prepare("QueryTable: Q=#rumour");
        expect(new Evaluator(prepared.main, prepared.extras).runByName("Other")).toBe("imported");
        expect(prepared.loadedPaths).toContain("Helpers.rdm");
    });

    test("shared builder retains the existing missing-property-provider error", () => {
        const query = parseDirectTagCall("#npc|prop:name");
        if (!query) throw new Error("fixture query failed to parse");
        expect(() => nativeQueryItems(query, ["A.md"])).toThrow("metadata cache");
    });
});
