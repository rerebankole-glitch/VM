#!/usr/bin/env node
/**
 * Optional browser regression test. The site and npm test remain dependency-free.
 * Install playwright-core, and supply CHROMIUM_EXECUTABLE_PATH (or install
 * @sparticuz/chromium on a compatible host). See docs/ARCHITECTURE.md.
 * All tests use bundled OS images / local HTTP fixtures. No public ISO download.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createVmServer } from "./serve.mjs";
import { checkLinuxDesktop } from "./linux-desktop-check.mjs";

let playwright;
try { playwright = await import("playwright-core"); }
catch { throw new Error("Install playwright-core to run the optional browser smoke test."); }
let executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
let args = ["--no-sandbox", "--disable-dev-shm-usage"];
if (!executablePath) {
    try {
        const chromium = (await import("@sparticuz/chromium")).default;
        executablePath = await chromium.executablePath();
        args = chromium.args.filter((arg) => !["--disable-web-security", "--allow-running-insecure-content"].includes(arg));
    } catch { throw new Error("Set CHROMIUM_EXECUTABLE_PATH to an installed Chromium binary."); }
}

// No external mirror fetches from the Node host during this test.
const server = createVmServer({ relayOptions: { mintUrls: [] } });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [], downloads = [], imageRequests = [];
const screenshots = process.argv.includes("--screenshots");
async function screenshot(page, name) {
    if (!screenshots) return;
    await fs.mkdir(".cache/qa", { recursive: true });
    await page.screenshot({ path: `.cache/qa/${name}.png`, fullPage: true });
}

try {
    browser = await playwright.chromium.launch({ executablePath, args, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    page.on("dialog", (dialog) => dialog.accept());
    // External mirrors are deliberately unavailable: the failure path must not
    // substitute another OS or fall back to a multi-GB download.
    await page.route("**/*", (route) => route.request().url().startsWith(base)
        ? route.continue()
        : route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "fixture: no external images" }));
    page.on("request", (request) => {
        if (request.url() === base + "/assets/images/tiny-linux.iso") imageRequests.push(request.headers().range);
    });
    await page.goto(base);
    await page.waitForSelector(".os-card");
    assert.equal(await page.locator("#stream-only").isChecked(), true);
    assert.equal(await page.locator("#status-pill").textContent(), "Ready");
    await screenshot(page, "welcome");

    await page.click('[data-quick-launch="kolibrios"]');
    await page.waitForSelector('body[data-vmstate="running"]');
    assert.ok(await page.locator("#screen-viewport").evaluate((element) => element.clientHeight > 300));
    // Do not mistake white kernel boot text for a desktop. Require coloured
    // pixels in both the middle and lower screen (the desktop / taskbar).
    await page.waitForFunction(() => {
        const canvas = document.querySelector("#screen_container canvas");
        if (!canvas.offsetWidth || canvas.width !== 800) return false;
        const context = canvas.getContext("2d");
        return [[100, 300], [400, 560]].every(([x, y]) => {
            const color = context.getImageData(x, y, 1, 1).data;
            return color[0] + color[1] + color[2] > 60;
        });
    }, null, { timeout: 60_000 });
    await screenshot(page, "desktop");
    assert.equal(await page.locator("body").getAttribute("data-input"), "released");
    await page.click("#screen-viewport", { position: { x: 100, y: 100 } });
    assert.equal(await page.locator("body").getAttribute("data-input"), "captured");
    await page.keyboard.press("Control+Alt+g");
    assert.equal(await page.locator("body").getAttribute("data-input"), "released");
    await page.click("#btn-pause");
    await page.waitForSelector("#paused-banner");
    await page.click("#btn-pause");
    await page.waitForSelector('body[data-vmstate="running"]');
    await page.click("#btn-fullscreen");
    await page.waitForFunction(() => document.fullscreenElement?.id === "screen-shell");
    assert.equal(await page.locator("#btn-pause").isVisible(), true, "fullscreen must keep the toolbar");
    await page.click("#btn-fullscreen");
    await page.waitForFunction(() => !document.fullscreenElement);

    await page.click("#tools-menu summary");
    await page.click("#btn-type");
    assert.equal(await page.locator("#type-input").isVisible(), true);
    assert.equal(await page.locator("body").getAttribute("data-input"), "released");
    await page.click("#type-close");
    await page.click("#tools-menu summary");
    await page.click("#btn-session-save");
    await page.waitForFunction(() => document.querySelector("#session-feedback").textContent.startsWith("Session saved here"));
    await page.click("#btn-power");
    await page.waitForSelector('body[data-vmstate="idle"]');
    assert.equal(await page.locator("#saved-session").isVisible(), true);
    await page.reload();
    await page.waitForSelector("#saved-session");
    await page.click("#btn-session-resume");
    await page.waitForSelector('body[data-vmstate="running"]');
    await page.waitForFunction(() => document.querySelector("#session-feedback").textContent.startsWith("Saved session resumed"));
    await page.click("#btn-power");
    await page.waitForSelector('body[data-vmstate="idle"]');
    await page.click("#btn-session-delete");
    await page.waitForSelector("#saved-session", { state: "hidden" });
    console.log("PASS: real desktop, focused input, pause, fullscreen toolbar, save/reload/resume/delete");

    await page.click("#quick-mint");
    assert.equal(await page.locator("#mint-stream").isDisabled(), true);
    await page.check("#mint-ack");
    await page.click("#mint-stream");
    await page.waitForFunction(() => document.querySelector("#mint-stream-status").textContent.startsWith("No accessible streaming source"));
    assert.equal(await page.locator("#status-pill").textContent(), "Ready");
    assert.equal(downloads.length, 0);
    await page.click("#mint-cancel");
    console.log("PASS: unsupported Mint acknowledgement and failed-source refusal without any download or substituted guest");

    await page.click("#btn-desktop");
    await page.click('[data-os="tiny-linux"]');
    await page.click('[data-tab="disk"]');
    await page.click('[data-sourcetab="file"]');
    await page.selectOption("#disk-mode", "ram");
    await page.click('[data-sourcetab="url"]');
    await page.fill("#url-input", "assets/images/tiny-linux.iso");
    await page.click("#url-use");
    await page.waitForFunction(() => document.querySelector("#source-current").textContent.includes("Remote stream"));
    await page.click("#btn-start");
    await page.waitForSelector('body[data-vmstate="running"]');
    await page.waitForFunction(() => /login:|\/root\s*[%#]|\/ #/.test(document.querySelector(".screen-text").textContent), null, { timeout: 45_000 });
    await page.click("#tools-menu summary");
    await page.click("#btn-type");
    await page.fill("#type-input", "echo WEBVM_TYPING_OK\n");
    await page.click("#type-send");
    await page.waitForFunction(() => (document.querySelector(".screen-text").textContent.match(/WEBVM_TYPING_OK/g) || []).length >= 2);
    assert.ok(imageRequests.length > 1, "guest must read real ISO blocks");
    assert.ok(imageRequests.every((range) => /^bytes=\d+-\d+$/.test(range)), "a local-file RAM preference must not cause a full remote ISO fetch");
    await screenshot(page, "linux-terminal");
    await page.click("#btn-power");
    await page.waitForSelector('body[data-vmstate="idle"]');
    console.log(`PASS: genuine Linux boot via ${imageRequests.length} bounded ISO range requests, despite a previous RAM-file preference`);

    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    mobile.on("pageerror", (error) => errors.push(error.message));
    await mobile.goto(base);
    await mobile.waitForSelector(".os-card");
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot(mobile, "mobile");

    const privatePage = await context.newPage();
    await privatePage.setViewportSize({ width: 1200, height: 800 });
    await privatePage.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
        Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("denied", "SecurityError"); } });
    });
    privatePage.on("pageerror", (error) => errors.push(error.message));
    privatePage.on("dialog", (dialog) => dialog.accept());
    await privatePage.goto(base);
    await privatePage.click('[data-quick-launch="kolibrios"]');
    await privatePage.waitForSelector('body[data-vmstate="running"]');
    await privatePage.click("#btn-power");
    console.log("PASS: mobile layout and running with all browser storage access denied");
    await checkLinuxDesktop({ context, base, screenshots });
    assert.deepEqual(errors, [], "no browser JavaScript errors");
    assert.deepEqual(downloads, [], "no unwanted file downloads");
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
