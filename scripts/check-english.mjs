#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

// Check project sources, including new files, while excluding ignored build output and dependencies.
const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" }
)
    .split("\0")
    .filter(Boolean);
const decoder = new TextDecoder("utf-8", { fatal: true });
const violations = [];
let checked = 0;
for (const file of files) {
    let bytes;
    try {
        if (!lstatSync(file).isFile()) continue;
        bytes = readFileSync(file);
    } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
    }
    // Binary verification keys and other binary assets are not natural-language project text.
    if (bytes.includes(0)) continue;
    let source;
    try {
        source = decoder.decode(bytes);
    } catch {
        continue;
    }
    checked++;
    source.split(/\r?\n/).forEach((line, index) => {
        if (/\p{Script=Han}/u.test(line))
            violations.push(`${file}:${index + 1}: Chinese text is not allowed`);
    });
}
if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
} else {
    console.log(`English-only check passed (${checked} text files).`);
}
