import { GeneratorFile, TableDecl } from "../engine/ast";
import { RNG } from "../engine/rng";
import { AsyncFileSource, prefetchUseGraph } from "./asyncPrefetcher";
import { dirname, ResolvedBundle, resolveBundle } from "./fileResolver";
import { extractNoteBlocks, sampleTagFiles, TAG_FILE_CAP, TagRollFilter } from "./mdContent";
import { nativeQueryItems, parseQueryTableSource } from "./nativeQuery";

export interface QueryTableOptions {
    source: AsyncFileSource;
    files: (filter: TagRollFilter) => string[];
    frontmatter: (path: string) => Record<string, unknown> | undefined;
    seed?: number;
    generatorRoot?: string;
    basenameResolver?: (basename: string, callerDir: string) => string | null;
    discover?: (bundle: ResolvedBundle) => Promise<GeneratorFile[]>;
}

/** Materialize fresh evaluation tables without changing the parsed declarations. */
export async function prepareQueryTables(
    input: ResolvedBundle,
    opts: QueryTableOptions
): Promise<ResolvedBundle> {
    if (![input.main, ...input.extras].some((file) => file.tables.some((table) => table.query))) {
        return input;
    }
    const clone = (file: GeneratorFile): GeneratorFile => ({ ...file, tables: file.tables.slice() });
    const bundle: ResolvedBundle = {
        main: clone(input.main),
        extras: input.extras.map(clone),
        loadedPaths: input.loadedPaths.slice(),
    };
    const rng = new RNG(opts.seed);
    const candidates = new Map<string, string[]>();
    const reads = new Map<string, Promise<string | null>>();
    const source: AsyncFileSource = {
        exists: (path) => opts.source.exists(path),
        read: (path) => {
            let pending = reads.get(path);
            if (!pending) {
                pending = opts.source.read(path);
                reads.set(path, pending);
            }
            return pending;
        },
    };
    const blockNames = new Map<string, string>();
    let prepared = 0;
    const allFiles = (): GeneratorFile[] => [bundle.main, ...bundle.extras];
    const names = (): Set<string> => new Set(
        allFiles().flatMap((file) => file.tables.map((table) => table.name.toLowerCase()))
    );
    const append = (file: GeneratorFile): void => {
        const taken = names();
        const tables = file.tables.filter((table) => {
            const name = table.name.toLowerCase();
            if (taken.has(name)) return false;
            taken.add(name);
            return true;
        });
        if (tables.length) bundle.extras.push({ ...file, tables });
    };

    while (true) {
        // Match the evaluator's registration order without running shadowed queries.
        const winning = new Map<string, TableDecl>();
        for (const file of allFiles()) {
            for (const table of file.tables) winning.set(table.name.toLowerCase(), table);
        }
        const pending: Array<{ file: GeneratorFile; index: number; table: TableDecl }> = [];
        for (const file of allFiles()) {
            file.tables.forEach((table, index) => {
                if (!table.query) return;
                if (winning.get(table.name.toLowerCase()) !== table &&
                    table !== bundle.main.tables[0]) {
                    const { query, ...ordinary } = table;
                    file.tables[index] = ordinary;
                } else {
                    pending.push({ file, index, table });
                }
            });
        }
        if (!pending.length) break;
        for (const { file, index, table } of pending) {
            const declaration = table.query;
            if (!declaration) throw new Error("Missing query declaration during preparation.");
            if (++prepared > 64) throw new Error("QueryTable preparation exceeded the 64-declaration limit.");
            try {
                const query = parseQueryTableSource(declaration.source);
                const key = JSON.stringify({ filter: query.filter, block: query.mode === "block" });
                let paths = candidates.get(key);
                if (!paths) {
                    const matches = opts.files(query.filter);
                    paths = query.mode === "block"
                        ? sampleTagFiles(matches, TAG_FILE_CAP, rng)
                        : matches;
                    candidates.set(key, paths);
                }
                if (query.mode === "block") {
                    for (const path of paths) {
                        if (blockNames.has(path)) continue;
                        const content = await source.read(path);
                        if (content === null) throw new Error(`Could not read query candidate '${path}'.`);
                        const prefetch = await prefetchUseGraph({
                            entryPath: path,
                            entrySource: content,
                            source,
                            generatorRoot: opts.generatorRoot,
                            basenameResolver: opts.basenameResolver,
                        });
                        const noteBundle = resolveBundle(path, content, {
                            callerDir: dirname(path),
                            source: prefetch.source,
                            generatorRoot: opts.generatorRoot,
                            basenameResolver: opts.basenameResolver,
                        });
                        const taken = names();
                        let suffix = blockNames.size;
                        let helperName = `__queryblock:${suffix}`;
                        while (taken.has(helperName.toLowerCase())) helperName = `__queryblock:${++suffix}`;
                        blockNames.set(path, helperName);
                        append({
                            uses: [],
                            topLevelSets: [],
                            prompts: [],
                            tables: [{
                                name: helperName,
                                hidden: true,
                                type: "weighted",
                                shuffleTargets: [],
                                inTableSets: [],
                                items: extractNoteBlocks(content).map((rawContent) => ({ weight: 1, rawContent })),
                            }],
                        });
                        append(noteBundle.main);
                        for (const extra of noteBundle.extras) append(extra);
                        for (const loaded of noteBundle.loadedPaths) {
                            if (!bundle.loadedPaths.includes(loaded)) bundle.loadedPaths.push(loaded);
                        }
                    }
                }
                const { query: unresolved, ...ordinary } = table;
                file.tables[index] = {
                    ...ordinary,
                    items: nativeQueryItems(query, paths, opts.frontmatter, (path) => {
                        const name = blockNames.get(path);
                        if (!name) throw new Error(`Missing prepared block table for '${path}'.`);
                        return name;
                    }),
                };
            } catch (error: unknown) {
                throw new Error(
                    `QueryTable '${table.name}' (${declaration.path ?? "generator"}, line ${declaration.line}): ` +
                    (error instanceof Error ? error.message : String(error))
                );
            }
        }
        if (opts.discover) {
            for (const extra of await opts.discover(bundle)) append(extra);
        }
    }
    return bundle;
}
