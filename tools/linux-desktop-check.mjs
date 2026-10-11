/** Native guest-browser regression; QA instrumentation is never shipped to users. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

export async function checkLinuxDesktop({ context, base, screenshots = false }) {
    const page = await context.newPage();
    const requests = [], errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
        if (request.url().includes("/assets/images/alpine-browser/")) requests.push(request.url());
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript(() => {
        let constructor;
        window.__qaSerial = "";
        Object.defineProperty(window, "V86", {
            configurable: true,
            get() { return constructor; },
            set(Original) {
                constructor = class extends Original {
                    constructor(options) {
                        super(options);
                        window.__qaGuest = this;
                        this.add_listener("serial0-output-byte", (byte) => {
                            window.__qaSerial += String.fromCharCode(byte);
                        });
                    }
                };
            },
        });
    });
    try {
        await page.goto(base);
        assert.equal(await page.locator("#quick-linux-internet").isChecked(), false);
        await page.check("#quick-linux-internet");
        assert.equal(await page.locator("#net-select").inputValue(), "widgetry");
        await page.uncheck("#quick-linux-internet");
        assert.equal(await page.locator("#net-select").inputValue(), "none");
        await page.click('[data-quick-launch="alpine-browser"]');
        await page.waitForSelector('body[data-vmstate="running"]');
        await page.waitForFunction(() => window.__qaSerial.includes("WEBVM_BROWSER_WINDOW_READY"), null, { timeout: 300_000 });
        await page.bringToFront();
        await page.evaluate(() => window.__qaGuest.serial0_send("DISPLAY=:0 xwininfo -root -tree > /opt/webvm/initial-window-tree.txt\n"));
        await page.waitForFunction(() => {
            const canvas = document.querySelector("#screen_container canvas");
            const color = canvas.getContext("2d").getImageData(250, 200, 1, 1).data;
            return color[0] > 225 && color[1] > 225 && color[2] > 225;
        }, null, { timeout: 75_000 });
        assert.equal(await page.locator("#source-badge").textContent(), "On-demand Linux files · no ISO");
        assert.equal(await page.locator("#btn-session-save").isDisabled(), true);
        assert.equal(await page.locator("#net-select").inputValue(), "none", "the app must not silently select a public relay");
        await page.waitForFunction(() => {
            const canvas = document.querySelector("#screen_container canvas");
            return canvas.width >= 800 && canvas.offsetWidth > 0;
        });
        if (screenshots) {
            await fs.mkdir(".cache/qa", { recursive: true });
            await page.screenshot({ path: ".cache/qa/linux-browser.png", fullPage: true });
        }

        // Navigate through actual PS/2 keyboard input to a different guest file.
        // Query X's native window tree over the independent serial console to
        // prove that Dillo, not host HTML or kernel text, changed its document.
        await page.click("#screen-viewport", { position: { x: 230, y: 180 } });
        await page.keyboard.press("Control+l");
        await page.keyboard.type("file", { delay: 35 });
        // CDP insertText/Keyboard.type(':') does not press physical Shift.
        // v86 consumes key codes, so exercise the real US-keyboard chord.
        await page.keyboard.press("Shift+Semicolon", { delay: 35 });
        await page.keyboard.type("///opt/webvm/test.html", { delay: 35 });
        await page.keyboard.press("Enter");
        await page.evaluate(() => window.__qaGuest.serial0_send(
            "(for i in $(seq 1 60); do DISPLAY=:0 xwininfo -root -tree > /opt/webvm/window-tree.txt; sleep 1; done) &\n",
        ));
        await page.evaluate(() => {
            window.__qaNavigationReady = false;
            const check = async () => {
                try {
                    const data = await window.__qaGuest.read_file("/opt/webvm/window-tree.txt");
                    window.__qaNavigationReady = new TextDecoder().decode(data).includes("WebVM navigation works");
                } catch { /* serial command has not created the file yet */ }
                if (!window.__qaNavigationReady) window.__qaNavigationTimer = setTimeout(check, 250);
            };
            void check();
        });
        await page.waitForFunction(() => window.__qaNavigationReady === true, null, { timeout: 70_000 });
        // X's title can change before fbdev finishes painting. Require the new
        // document's white body, not the previous welcome page or a blank desktop.
        await page.waitForFunction(() => {
            const context = document.querySelector("#screen_container canvas").getContext("2d");
            return [[300, 450], [650, 550]].every(([x, y]) => {
                const p = context.getImageData(x, y, 1, 1).data;
                return p[0] === 255 && p[1] === 255 && p[2] === 255;
            });
        }, null, { timeout: 75_000 });
        if (screenshots) await page.screenshot({ path: ".cache/qa/linux-browser-navigation.png", fullPage: true });
        assert.ok(requests.some((url) => url.endsWith("/fs.json")));
        assert.ok(requests.filter((url) => url.endsWith(".bin.zst")).length > 20, "Linux must read actual filesystem objects");
        assert.ok(requests.every((url) => !/\.iso(?:$|\?)/.test(url)), "there must be no ISO request");
        assert.deepEqual(errors, []);
        console.log(`PASS: Alpine Linux desktop, native Dillo window and real local-page navigation; ${requests.length} on-demand file requests; no ISO or implicit relay`);
        await page.click("#btn-power");
        await page.waitForSelector('body[data-vmstate="idle"]');
    } catch (error) {
        console.error("Linux guest serial tail:", await page.evaluate(() => window.__qaSerial?.slice(-9000)));
        console.error("Browser errors:", errors);
        for (const file of ["/opt/webvm/initial-window-tree.txt", "/opt/webvm/window-tree.txt", "/tmp/dillo.log", "/tmp/fluxbox.log"]) {
            try { console.error(file, await page.evaluate(async (path) => new TextDecoder().decode(await window.__qaGuest.read_file(path)), file)); } catch { /* not created yet */ }
        }
        if (screenshots) {
            await fs.mkdir(".cache/qa", { recursive: true });
            await page.screenshot({ path: ".cache/qa/linux-browser-failure.png", fullPage: true });
        }
        throw error;
    } finally { await page.close({ runBeforeUnload: false }); }
}
