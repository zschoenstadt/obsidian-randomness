import { parseDirectTagCall, tagVariableNames } from "../../src/resolver/mdContent";
import { parseQueryTableSource } from "../../src/resolver/nativeQuery";

describe("tag-roll selection variables", () => {
    test("substitute tags, property keys, alternatives and folders using normal variable syntax", () => {
        const query = parseDirectTagCall(
            "#{$Kind}|#npc,#{kind}|{$Property}={$Value},literal|folder=Worlds/{$Folder}|link",
            { KIND: "merchant", property: "job", value: "smith", folder: "Eldara" }
        );
        expect(query?.filter).toEqual({
            tagGroups: [["merchant"], ["npc", "merchant"]],
            props: [{ key: "job", values: ["smith", "literal"] }],
            folders: ["Worlds/Eldara"],
        });
        expect(query?.mode).toBe("link");
    });

    test("support positional variables and zero", () => {
        expect(parseQueryTableSource("*|level={$1}|folder={$2}|link", {
            "1": 0, "2": "Bestiary",
        }).filter).toEqual({
            tagGroups: [], props: [{ key: "level", values: ["0"] }], folders: ["Bestiary"],
        });
    });

    test("collect only selection variables once, not controls or output-template references", () => {
        expect(tagVariableNames(
            "{$count}#{$Kind}|#npc,#{kind}|{$Property}={$Value},{$value}|folder={$Folder}|" +
            "sep:{$separator}|unique|prop:{{name}} {$output}|{$tail}"
        )).toEqual(["kind", "property", "value", "folder"]);
    });

    test.each(["A,B", "x|link", "a=b", "{$another}", '""', "[[Worlds/Eldara|The Realm]]", "a\\b"])(
        "replacement %s stays one literal property value", (value) => {
            const query = parseDirectTagCall("*|title={$title}|link", { title: value });
            expect(query?.filter.props).toEqual([{ key: "title", values: [value] }]);
            expect(query?.mode).toBe("link");
        }
    );

    test("authors still control alternatives, not replacement data", () => {
        expect(parseDirectTagCall("*|title={$a},{$b}|link", {
            a: "A,B", b: "C|D",
        })?.filter.props).toEqual([{ key: "title", values: ["A,B", "C|D"] }]);
    });

    test("replacement punctuation does not create tags, properties or output modes", () => {
        expect(parseDirectTagCall("#{$tag}|link", { tag: "npc,monster" })).toBeNull();
        expect(parseDirectTagCall("*|{$key}=value|link", { key: "a=b" })?.filter.props)
            .toEqual([{ key: "a=b", values: ["value"] }]);
        expect(parseDirectTagCall("#{$tag}|link", { tag: "*" })).toBeNull();
    });

    test.each(["", " ", "   "])("empty field %j uses existing literal validation", (value) => {
        expect(parseDirectTagCall("*|job={$job}|link", { job: value }))
            .toEqual(parseDirectTagCall(`*|job=${value}|link`));
        expect(parseDirectTagCall("#{$tag}|link", { tag: value }))
            .toEqual(parseDirectTagCall(`#${value}|link`));
        expect(parseDirectTagCall("*|folder={$folder}|link", { folder: value }))
            .toEqual(parseDirectTagCall(`*|folder=${value}|link`));
        expect(parseDirectTagCall("*|{$key}=value|link", { key: value }))
            .toEqual(parseDirectTagCall(`*|${value}=value|link`));
    });

    test("normalize after replacement and preserve removal of empty alternatives", () => {
        expect(parseDirectTagCall("*|job={$blank},smith|folder={$folder}|link", {
            blank: "", folder: "\\Bestiary\\Undead\\",
        })).toEqual(parseDirectTagCall("*|job=,smith|folder=\\Bestiary\\Undead\\|link"));
        expect(parseDirectTagCall("*|job={$job}|link", { job: " smith " }))
            .toEqual(parseDirectTagCall("*|job= smith |link"));
    });

    test("quote characters are literal, not decoded or manufactured", () => {
        expect(parseDirectTagCall('*|job=""|link')?.filter.props)
            .toEqual([{ key: "job", values: ['""'] }]);
        expect(parseDirectTagCall("*|job={$job}|link", { job: '""' }))
            .toEqual(parseDirectTagCall('*|job=""|link'));
        expect(parseDirectTagCall("*|job={$job}|link", { job: "" })).toBeNull();
    });

    test.each(["#{$kind}|link", "#npc|job={$job}|link", "*|folder={$folder}|link", "*|{$key}=x|link"])(
        "empty inline context reports unavailable references: %s", (source) => {
            expect(() => parseDirectTagCall(source, {})).toThrow("isn't available in this context");
        }
    );

    test("inherited object keys are not supplied variable bindings", () => {
        const inherited: Record<string, string> = Object.create({ level: "1" });
        expect(() => parseDirectTagCall("*|level={$level}|link", inherited)).toThrow("isn't available");
    });

    test("prop syntax and output variables do not use the selection bindings", () => {
        const source = "#npc|prop:{{name}} {$level}|unique|sep:{$separator}";
        expect(parseDirectTagCall(source, {})).toEqual(parseDirectTagCall(source, { level: 9, separator: "," }));
        expect(tagVariableNames(source)).toEqual([]);
        expect(parseDirectTagCall(source)?.template).toBe("{{name}} {$level}|unique|sep:{$separator}");
        expect(parseDirectTagCall("#npc|prop:cr", { cr: 9 })?.template).toBe("{{cr}}");
    });

    test("escaped and expression-looking fields retain their original literal behavior", () => {
        expect(tagVariableNames("*|value=\\{$value}|link")).toEqual([]);
        expect(parseDirectTagCall("*|value=\\{$value}|link")?.filter.props[0].values).toEqual(["\\{$value}"]);
        expect(tagVariableNames("*|value={1d6}|link")).toEqual([]);
        expect(parseDirectTagCall("*|value={1d6}|link")?.filter.props[0].values).toEqual(["{1d6}"]);
        expect(tagVariableNames("*|value={{name}}|link")).toEqual([]);
        expect(parseDirectTagCall("ordinary text with {$level}", {})).toBeNull();
    });
});
