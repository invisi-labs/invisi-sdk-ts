import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const allowedDependencies = {
    primitives: [],
    protocol: ["primitives"],
    prover: ["primitives", "protocol"],
    rpc: ["primitives", "protocol"],
    sdk: ["primitives", "protocol", "prover", "rpc"],
    session: ["primitives", "protocol", "sdk", "rpc"],
    react: ["sdk", "session"],
    vue: ["sdk", "session"],
};
export function validateDependency(owner, dependency, location) {
    assert(
        owner === dependency || allowedDependencies[owner]?.includes(dependency),
        `${location}: forbidden ${owner} -> ${dependency}`
    );
}
function sources(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory()
            ? sources(path)
            : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)
              ? [path]
              : [];
    });
}
export function checkModuleBoundaries() {
    for (const owner of Object.keys(allowedDependencies)) {
        const manifest = JSON.parse(readFileSync(`packages/${owner}/package.json`, "utf8"));
        assert.equal(manifest.name, `@invisi-labs/${owner}`);
        for (const [name] of Object.entries({
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
        })) {
            if (name.startsWith("@invisi-labs/"))
                validateDependency(owner, name.slice(13), manifest.name);
            if (["primitives", "protocol"].includes(owner))
                assert(!/@aztec|@noir/.test(name), `${owner} contains proving runtime ${name}`);
        }
        for (const path of sources(`packages/${owner}/src`)) {
            const source = readFileSync(path, "utf8");
            for (const match of source.matchAll(
                /(?:from\s*|import\s*\()["']@invisi-labs\/([a-z-]+)(?:\/[^"']*)?["']/g
            ))
                validateDependency(owner, match[1], path);
            assert(!/@invisi-labs\/core(?:\/|["'])/.test(source), `${path}: retired package name`);
            if (["primitives", "protocol", "prover"].includes(owner))
                assert(
                    !/\bfetch\s*\(|\bXMLHttpRequest\b|new\s+WebSocket\s*\(/.test(source),
                    `${path}: network execution in offline module`
                );
            if (["primitives", "protocol"].includes(owner))
                assert(
                    !/["'](?:@aztec|@noir)/.test(source),
                    `${path}: proving runtime in pure module`
                );
        }
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    checkModuleBoundaries();
    console.log("Six-module dependency boundaries PASS");
}
