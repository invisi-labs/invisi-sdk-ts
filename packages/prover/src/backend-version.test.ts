import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBBAvailable } from "./backend-bb";

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

const shell = process.platform === "win32" ? describe.skip : describe;
shell("native BB toolchain selection", () => {
    async function executable(version: string, requireStableMsm = false) {
        const directory = await mkdtemp(join(tmpdir(), "invisi-bb-version-"));
        directories.push(directory);
        const path = join(directory, "bb");
        const check = requireStableMsm ? '[ "${BB_MSM_LEGACY+x}" = x ] || exit 9\n' : "";
        await writeFile(path, `#!/bin/sh\n${check}printf '%s\\n' '${version}'\n`);
        await chmod(path, 0o755);
        return path;
    }

    it("accepts BB 6 with the stable MSM environment", async () => {
        expect(await checkBBAvailable(await executable("6.0.0", true))).toBe(true);
    });

    it("rejects previous BB versions", async () => {
        expect(await checkBBAvailable(await executable("5.2.1"))).toBe(false);
    });
});
