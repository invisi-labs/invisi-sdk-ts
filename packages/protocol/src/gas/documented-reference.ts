import { CIRCUIT_RELEASE } from "../release-identity";
import catalog from "./data/documented-references.json";
export type DocumentedReleaseIdentity =
    | { creditManifestVersion: number; creditFormatVersion: number; creditManifestSha256?: string }
    | { userManifestVersion: number; userFormatVersion: number };
export type DocumentedGasShape = Readonly<Record<string, string | number | boolean>>;
export type DocumentedGasReference =
    | {
          source: "documented-reference";
          available: false;
          reason: "shape-not-covered" | "release-not-covered";
      }
    | {
          source: "documented-reference";
          available: true;
          gasUnits: bigint;
          statistic: "median";
          sampleCount: number;
          referenceId: string;
          document: string;
          sourceSha256: string;
          docsCommit: string;
          conditions: string;
          assumptions: readonly string[];
          releaseIdentity: DocumentedReleaseIdentity;
      };
/** Exact documented workload lookup. This is neither a transaction gas limit nor an RPC estimate. */
export function getDocumentedGasReference(query: DocumentedGasShape): DocumentedGasReference {
    const row = catalog.references.find((r) => {
        const shape = r.shape as DocumentedGasShape;
        return (
            Object.keys(query).length === Object.keys(shape).length &&
            Object.keys(shape).every((k) => query[k] === shape[k])
        );
    });
    if (!row)
        return { source: "documented-reference", available: false, reason: "shape-not-covered" };
    const identity = row.releaseIdentity as DocumentedReleaseIdentity;
    if (
        "creditManifestVersion" in identity &&
        (identity.creditManifestVersion !== CIRCUIT_RELEASE.credit.version ||
            identity.creditFormatVersion !== CIRCUIT_RELEASE.credit.formatVersion ||
            !/^[a-f0-9]{64}$/.test(identity.creditManifestSha256 ?? "") ||
            !/^[a-f0-9]{64}$/.test(CIRCUIT_RELEASE.credit.manifestSha256) ||
            identity.creditManifestSha256 !== CIRCUIT_RELEASE.credit.manifestSha256)
    )
        return { source: "documented-reference", available: false, reason: "release-not-covered" };
    const source = catalog.sources.find((s) => s.path === row.source)!;
    return {
        source: "documented-reference",
        available: true,
        gasUnits: BigInt(row.gasUnits),
        statistic: "median",
        sampleCount: row.sampleCount,
        referenceId: row.id,
        document: row.source,
        sourceSha256: source.sha256,
        docsCommit: catalog.docsCommit,
        conditions: source.conditions,
        assumptions: catalog.assumptions,
        releaseIdentity: row.releaseIdentity as unknown as DocumentedReleaseIdentity,
    };
}
