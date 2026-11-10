import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require("playwright"));
} catch {
    ({ chromium } = require("/tmp/invisi-ui-tools/node_modules/playwright"));
}
export async function browserScenario({
    root,
    serviceRoot,
    serviceURL,
    report,
    save,
    step,
    skipExisting = false,
}) {
    const base = serviceURL.replace("/v1/chains/31337", "");
    if (!skipExisting) {
        step("real-browser-existing-99-checks");
        await new Promise((resolve, reject) => {
            const p = spawn(
                process.execPath,
                [
                    "--require",
                    fileURLToPath(new URL("./provenance-e2e-browser-pacing.cjs", import.meta.url)),
                    join(serviceRoot, "web/tests/browser.mjs"),
                ],
                {
                    cwd: root,
                    env: { ...process.env, EXPLORER_URL: base },
                    stdio: "inherit",
                }
            );
            p.once("exit", (c) => (c === 0 ? resolve() : reject(Error("browser99 failed " + c))));
            p.once("error", reject);
        });
    }
    step("real-browser-populated-details");
    const browser = await chromium.launch({
        executablePath:
            process.env.CHROME_PATH ??
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
    });
    let checked = 0;
    const failures = [];
    const scope = `chainId=31337&protocolAddress=${report.protocolAddress}`;
    const details = [
        `/transactions/${report.privateTransaction}?${scope}`,
        `/notes/${report.outputCommitment}?${scope}`,
        `/credit-states/${report.credit.creditCommitment}?${scope}`,
    ];
    try {
        for (const width of [320, 390, 1440]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            page.on("pageerror", (e) => failures.push(e.message));
            page.on("response", (r) => {
                if (r.url().includes("/api/") && r.status() >= 400)
                    failures.push("HTTP " + r.status() + " " + new URL(r.url()).pathname);
            });
            for (const language of ["en", "zh-Hans", "zh-Hant"])
                for (const route of details) {
                    await new Promise((r) => setTimeout(r, 2200));
                    await page.goto(base + route);
                    await page.locator("select").selectOption(language);
                    await page.locator("h1").waitFor();
                    await page.waitForTimeout(300);
                    assert.equal(await page.locator("html").getAttribute("lang"), language);
                    const overflowing = await page.evaluate(
                        () => document.documentElement.scrollWidth > innerWidth
                    );
                    if (overflowing)
                        save("browser-overflow.json", {
                            route,
                            width,
                            language,
                            elements: await page.evaluate(() =>
                                [...document.querySelectorAll("*")]
                                    .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
                                    .slice(0, 30)
                                    .map((e) => ({
                                        tag: e.tagName,
                                        class: e.className,
                                        text: e.textContent.slice(0, 200),
                                        right: e.getBoundingClientRect().right,
                                        width: e.getBoundingClientRect().width,
                                    }))
                            ),
                        });
                    assert.equal(
                        await page.evaluate(
                            () => document.documentElement.scrollWidth > innerWidth
                        ),
                        false,
                        route + " overflow"
                    );
                    const text = await page.locator("body").innerText();
                    assert(!text.includes("Loading…"), "detail remains loading");
                    const identifier = route.split("/")[2].split("?")[0];
                    assert(
                        text.toLowerCase().includes(identifier.toLowerCase()),
                        "populated detail must display the actual requested public identifier"
                    );
                    checked++;
                }
            await page.close();
        }
        assert.deepEqual(failures, []);
    } finally {
        await browser.close();
    }
    const result = {
        existingRouteChecks: skipExisting ? 0 : 99,
        populatedDetailChecks: checked,
        languages: ["en", "zh-Hans", "zh-Hant"],
        widths: [320, 390, 1440],
        pageErrors: failures,
    };
    save("browser-flow.json", result);
    return result;
}
