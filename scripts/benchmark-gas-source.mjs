/** Content identities include tracked and untracked executable inputs, without requiring commits. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function fingerprintFiles(root, files) {
    const hashes = Object.fromEntries(
        [...new Set(files)]
            .sort()
            .filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile())
            .map((path) => [path, sha256(readFileSync(join(root, path)))])
    );
    const framed = Object.entries(hashes)
        .map(([path, hash]) => `${Buffer.byteLength(path)}:${path}:${hash}\n`)
        .join("");
    return { sha256: sha256(framed), files: hashes };
}
export function sourceIdentity(root) {
    const paths = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 }
    )
        .toString()
        .split("\0")
        .filter(Boolean);
    // Compiler dependencies can be submodules; inspect their materialized executable sources too.
    function libraries(path) {
        if (!existsSync(join(root, path))) return;
        for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            const p = path + "/" + entry.name;
            if (entry.isDirectory()) libraries(p);
            else if (/\.(sol|nr|toml)$/.test(p)) paths.push(p);
        }
    }
    libraries("lib");
    return fingerprintFiles(
        root,
        paths.filter(
            (p) =>
                !p.includes("/target/") &&
                !p.includes("/out/") &&
                !p.includes("/dist/") &&
                (/\.(sol|nr|mjs|ts|json|toml|yaml|yml)$/.test(p) ||
                    /^(Makefile|\.nargo-version|\.bb-version|\.noir-js-version)$/.test(p))
        )
    );
}
/** Incremental insert costs 16 hashes; every membership is 16 cached lookups. */
export class BenchmarkMerkleTree {
    constructor(hash) {
        this.hash = hash;
        this.levels = Array.from({ length: 17 }, () => new Map());
        this.zeros = [0n];
        this.size = 0;
    }
    async initialize() {
        for (let i = 0; i < 16; i++)
            this.zeros.push(BigInt(await this.hash([this.zeros[i], this.zeros[i]])));
        return this;
    }
    async insert(value) {
        let index = this.size++,
            current = BigInt(value);
        this.levels[0].set(index, current);
        for (let depth = 0; depth < 16; depth++) {
            const sibling = this.levels[depth].get(index ^ 1) ?? this.zeros[depth];
            current = BigInt(await this.hash(index & 1 ? [sibling, current] : [current, sibling]));
            index >>= 1;
            this.levels[depth + 1].set(index, current);
        }
    }
    membership(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.size)
            throw Error("invalid benchmark leaf index");
        let cursor = index;
        const path = [];
        for (let depth = 0; depth < 16; depth++) {
            path.push(this.levels[depth].get(cursor ^ 1) ?? this.zeros[depth]);
            cursor >>= 1;
        }
        return {
            leaf: this.levels[0].get(index),
            path,
            root: this.levels[16].get(0) ?? this.zeros[16],
        };
    }
}
