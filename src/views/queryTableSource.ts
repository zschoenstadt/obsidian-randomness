import { discoverReferencedTables } from "../resolver/autoDiscover";
import { ResolvedBundle } from "../resolver/fileResolver";
import { prepareQueryTables } from "../resolver/queryTables";
import type RandomnessPlugin from "./main";
import { makeLinkAwareBasenameResolver, makeTagFilesLookup, makeTagFrontmatterLookup, vaultFileSource } from "./vaultFileSource";

export async function prepareVaultQueryTables(
    plugin: RandomnessPlugin,
    bundle: ResolvedBundle,
    seed?: number
): Promise<ResolvedBundle> {
    const source = vaultFileSource(plugin.app.vault);
    return prepareQueryTables(bundle, {
        source,
        files: makeTagFilesLookup(plugin, { strict: true }),
        frontmatter: makeTagFrontmatterLookup(plugin, { strict: true }),
        seed,
        generatorRoot: plugin.settings.generatorRoot || undefined,
        basenameResolver: makeLinkAwareBasenameResolver(plugin),
        discover: plugin.vaultIndex ? async (prepared) => {
            await plugin.vaultIndex.prewarm();
            return discoverReferencedTables({
                main: prepared.main,
                extras: prepared.extras,
                alreadyLoaded: prepared.loadedPaths,
                source,
                generatorRoot: plugin.settings.generatorRoot || undefined,
                resolveTableName: (name) => plugin.vaultIndex.resolveTable(name),
            });
        } : undefined,
    });
}
