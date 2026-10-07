/**
 * @jest-environment jsdom
 */
import { TFile, WorkspaceLeaf } from "obsidian";
import { createApi } from "../../src/api";
import { DeckService, FolderDeck } from "../../src/decks/deckService";
import { VaultIndex } from "../../src/resolver/vaultIndex";
import { discoverGenerators, rollTable } from "../../src/views/browserView";
import { buildCodeblockProcessor } from "../../src/views/codeblockProcessor";
import { evaluateInlineExpression } from "../../src/views/inlineProcessor";
import { IptView } from "../../src/views/iptView";
import { PreviewRegistry } from "../../src/views/lockingService";
import { DEFAULT_SETTINGS } from "../../src/views/settings";

function fixture(files: Record<string, string>) {
    const read = jest.fn(async (path: string) => {
        if (!(path in files)) throw new Error(`Missing ${path}`);
        return files[path];
    });
    const entries = Object.keys(files).map((path) => {
        const file = new TFile();
        file.path = path;
        file.basename = path.replace(/\.[^.]+$/, "");
        file.extension = path.split(".").pop() ?? "";
        return file;
    });
    const cache = jest.fn((file: { path: string }) => ({
        tags: file.path === "NPC.md" ? [{ tag: "#npc" }] : [],
        frontmatter: file.path === "NPC.md" ? { cr: 3, rumours: ["one", "two"] } : {},
    }));
    const plugin = {
        app: {
            vault: {
                adapter: { read, exists: async (path: string) => path in files },
                read: async (file: { path: string }) => read(file.path),
                cachedRead: async (file: { path: string }) => read(file.path),
                getFiles: () => entries,
                getMarkdownFiles: () => entries.filter((file) => file.extension === "md"),
                getAbstractFileByPath: (path: string) => entries.find((file) => file.path === path) ?? null,
            },
            metadataCache: {
                getFileCache: cache,
                getCache: (path: string) => cache({ path }),
                getFirstLinkpathDest: () => null,
            },
            workspace: { getActiveFile: () => entries.find((file) => file.path === "Note.md") ?? null },
        },
        settings: { ...DEFAULT_SETTINGS },
        previewRegistry: new PreviewRegistry(),
        vaultIndex: new VaultIndex({ getFiles: () => entries, read }, () => ""),
    };
    return { plugin, read, cache };
}

const QUERY = "QueryTable: People=#npc|prop:{{name}} (CR {{cr}})";
const NPC = "---\ntags: [npc]\ncr: 3\n---\nA merchant.";

describe("named queries across plugin surfaces", () => {
    test("inline reference inside prose and API scoped rolls", async () => {
        const { plugin } = fixture({
            "Note.md": `\`\`\`randomness\n${QUERY}\n\`\`\``,
            "NPC.md": NPC,
        });
        expect(await evaluateInlineExpression("Meet [@People].", "Note.md", plugin as never, { seed: 3 }))
            .toBe("Meet NPC (CR 3).");
        expect((await createApi(plugin as never).roll("People", { seed: 3 })).result).toBe("NPC (CR 3)");
    });

    test("API unscoped direct-file roll and browser roll", async () => {
        const { plugin } = fixture({ "queries.rdm": QUERY, "NPC.md": NPC });
        expect((await createApi(plugin as never).rollUnscoped("People", {
            filePath: "queries.rdm", seed: 3,
        })).result).toBe("NPC (CR 3)");
        expect(await rollTable(plugin as never, "queries.rdm", "People")).toBe("NPC (CR 3)");
    });

    test("imports and auto-discovered declarations", async () => {
        const { plugin } = fixture({
            "queries.rdm": QUERY, "NPC.md": NPC,
            "Note.md": "```randomness\nUse: queries.rdm\n```",
            "Empty.md": "",
        });
        expect(await evaluateInlineExpression("[@People]", "Note.md", plugin as never)).toBe("NPC (CR 3)");
        expect(await evaluateInlineExpression("[@People]", "Empty.md", plugin as never)).toBe("NPC (CR 3)");
    });

    test("codeblocks can call a query table elsewhere in the same note", async () => {
        const source = "Table: Main\nHello [@People].";
        const note = `\`\`\`randomness\n${source}\n\`\`\`\n\n\`\`\`randomness\n${QUERY}\n\`\`\``;
        const { plugin } = fixture({ "Note.md": note, "NPC.md": NPC });
        const element = document.createElement("div");
        await buildCodeblockProcessor(plugin as never)(source, element, {
            sourcePath: "Note.md",
            addChild() {},
            getSectionInfo: () => ({ lineStart: 0, lineEnd: 3, text: note }),
        } as never);
        expect(element.textContent).toContain("Hello NPC (CR 3).");
        expect(element.querySelector(".randomness-error")).toBeNull();
    });

    test("file view evaluates a main query table", async () => {
        const { plugin } = fixture({ "queries.rdm": QUERY, "NPC.md": NPC });
        const view = new IptView(new WorkspaceLeaf(), plugin as never);
        const file = new TFile();
        file.path = "queries.rdm";
        view.file = file;
        await view.onOpen();
        view.setViewData(QUERY, true);
        for (let attempt = 0; attempt < 30 && !view.containerEl.querySelector(".randomness-output"); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(view.containerEl.querySelector(".randomness-output")?.textContent).toBe("NPC (CR 3)");
    });

    test("discovery and API listing do not execute native queries", async () => {
        const { plugin, cache, read } = fixture({ "queries.rdm": QUERY, "NPC.md": NPC, "Note.md": "" });
        const discovered = await discoverGenerators(plugin as never);
        expect(discovered.some((result) => result.ok && result.gen.tables.some((table) => table.name === "People")))
            .toBe(true);
        expect(await createApi(plugin as never).tables()).toContain("People");
        expect(cache).not.toHaveBeenCalled();
        expect(read.mock.calls.some(([path]) => path === "NPC.md")).toBe(false);
    });

    test("metadata changes are reflected on the next roll, not in a stale result cache", async () => {
        const { plugin, cache } = fixture({ "queries.rdm": QUERY, "NPC.md": NPC });
        expect(await rollTable(plugin as never, "queries.rdm", "People")).toBe("NPC (CR 3)");
        cache.mockImplementation((file) => ({
            tags: file.path === "NPC.md" ? [{ tag: "#npc" }] : [],
            frontmatter: file.path === "NPC.md" ? { cr: 5, rumours: ["new"] } : {},
        }));
        expect(await rollTable(plugin as never, "queries.rdm", "People")).toBe("NPC (CR 5)");
    });

    test("metadata backend failures propagate rather than returning an empty query", async () => {
        const { plugin, cache } = fixture({ "queries.rdm": QUERY, "NPC.md": NPC });
        cache.mockImplementation(() => { throw new Error("metadata offline"); });
        await expect(rollTable(plugin as never, "queries.rdm", "People")).rejects.toThrow("metadata offline");
    });

    test("static folder-deck card text can call an auxiliary query table", async () => {
        const cardSource = `Table: Cards\nType: dictionary\nmerchant: Meet [@People].\n${QUERY}`;
        const { plugin } = fixture({ "Cards.rdm": cardSource, "NPC.md": NPC });
        const deck: FolderDeck = {
            name: "Cards", folderPath: "Cards",
            cards: [{ name: "merchant", textKey: "merchant" }],
            settings: { flip: 0 },
            state: { total: 1, remaining: [0], drawn: [], removed: [] },
            rdmSource: cardSource, rdmPath: "Cards.rdm", tableName: "Cards",
        };
        const result = await new DeckService(plugin as never).resolveDraw(deck, 0, "upright");
        expect(result.text).toBe("Meet NPC (CR 3).");
    });
});
