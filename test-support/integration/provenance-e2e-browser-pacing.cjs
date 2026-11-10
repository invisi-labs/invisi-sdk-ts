// Pace real requests against the public read limit without rewriting responses.
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
let chromium;
try {
    ({ chromium } = req("playwright"));
} catch {
    ({ chromium } = require("/tmp/invisi-ui-tools/node_modules/playwright"));
}
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
    const browser = await launch(...args),
        newPage = browser.newPage.bind(browser),
        close = browser.close.bind(browser),
        failures = [];
    browser.close = async () => {
        await close();
        if (failures.length) throw Error("Real API browser failures: " + failures.join(", "));
    };
    browser.newPage = async (...args) => {
        const page = await newPage(...args),
            goto = page.goto.bind(page);
        page.on("response", (r) => {
            if (r.url().includes("/api/") && r.status() >= 400)
                failures.push(String(r.status()) + " " + new URL(r.url()).pathname);
        });
        page.goto = async (...args) => {
            await new Promise((r) => setTimeout(r, 2200));
            return goto(...args);
        };
        return page;
    };
    return browser;
};
