/**
 * Static consistency checks: the page, the modules and the vendored emulator
 * must agree with each other. These catch the classic "renamed an id and the
 * button silently stopped working" bugs without needing a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG } from "../app/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const html = read("index.html");
const appJs = read("app/app.js");
const engineJs = read("app/engine.js");
const css = read("app/styles.css");

test("index.html loads the emulator and the app modules", () => {
    assert.match(html, /<script src="assets\/v86\/libv86\.js"><\/script>/, "libv86.js is not loaded before the app");
    assert.match(html, /<script type="module" src="app\/app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="app\/styles\.css">/);
    // The emulator must be loaded before the module that uses window.V86.
    assert.ok(
        html.indexOf("assets/v86/libv86.js") < html.indexOf("app/app.js"),
        "libv86.js must be included before app.js",
    );
});

test("every element the app looks up exists in the page", () => {
    const ids = new Set([...appJs.matchAll(/\$\$?\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 25, `only found ${ids.size} ids — the selector scan probably broke`);

    const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
    assert.deepEqual(missing, [], `index.html is missing: ${missing.join(", ")}`);
});

test("every data-attribute the app toggles exists in the page", () => {
    const attributes = new Set([...appJs.matchAll(/\[data-([a-z-]+)\]/g)].map((m) => m[1]));
    assert.ok(attributes.size > 0, "the selector scan found no data-attributes");
    const missing = [...attributes].filter((attribute) => {
        // Static markup lives in index.html, dynamic markup is built in app.js.
        const inHtml = html.includes(`data-${attribute}`);
        const generated = appJs.includes(`data-${attribute}="`);
        return !inHtml && !generated;
    });
    assert.deepEqual(missing, [], `no data-${missing.join(", data-")} anywhere in the app`);
    // The disk panel swaps these panels, so the names must line up exactly.
    for (const tab of ["builtin", "file", "url"]) {
        assert.ok(html.includes(`data-sourcetab="${tab}"`), `missing source tab ${tab}`);
        assert.ok(html.includes(`data-sourcepanel="${tab}"`), `missing source panel ${tab}`);
    }
});

test("the sidebar steps actually switch panels", () => {
    // Regression: the step buttons used to be decorative, which hid the disk
    // panel (and with it every download link) behind an unreachable tab.
    assert.match(appJs, /\[data-tab\]/, "nothing binds the step buttons");
    assert.match(appJs, /\[data-panel\]/, "nothing shows the step panels");
    for (const step of ["os", "disk", "machine"]) {
        assert.ok(html.includes(`data-tab="${step}"`), `no step button for ${step}`);
        assert.ok(html.includes(`data-panel="${step}"`), `no panel for ${step}`);
    }
    assert.match(appJs, /classList\.toggle\("is-active", active\)/, "the active step is never highlighted");
});

test("download links are reachable from step 1, not hidden in step 2", () => {
    assert.ok(html.includes('id="os-download"'), "step 1 has nowhere to show the download links");
    assert.match(appJs, /renderDownloadBox\(entry\)/, "the download box is never filled in");
    assert.match(appJs, /#os-next/, "step 1 has no way to reach the disk panel");
    // Every non-bundled entry must have something to offer the user.
    for (const entry of CATALOG.filter((item) => item.status !== "instant")) {
        assert.ok(entry.links?.length, `${entry.id} would render a download box with no links`);
    }
});

test("the v86 event names the app listens for are documented by v86 itself", () => {
    const types = read("assets/v86/v86.d.ts");
    const events = new Set([...engineJs.matchAll(/(?:add_listener|on)\("([^"]+)"/g)].map((m) => m[1]));
    assert.ok(events.size >= 5, "expected the engine to subscribe to several events");
    for (const event of events) {
        assert.ok(types.includes(`"${event}"`), `v86.d.ts does not declare the "${event}" event`);
    }
});

test("every v86 method the app calls exists in the vendored build", () => {
    const bundle = read("assets/v86/libv86.js");
    const methods = new Set([
        ...[...appJs.matchAll(/engine\.([a-zA-Z0-9_]+)\(/g)].map((m) => m[1]),
        ...[...engineJs.matchAll(/(?:this\.v86|v86|this\.v86\?)\.([a-z0-9_]+)\??\.?\(/g)].map((m) => m[1]),
    ]);
    const ignored = new Set(["boot", "isAttached", "isRunning", "v86"]);
    const engineMethods = new Set([
        "boot", "run", "pause", "reset", "destroy", "setKeyboardEnabled", "setMouseEnabled",
        "releaseModifiers", "sendCtrlAltDel", "sendText", "screenshot", "lockMouse", "goFullscreen",
        "instructionCounter", "uptimeMs", "saveState", "restoreState", "setImage", "eject", "sendEnter",
    ]);

    const toCheck = [...methods].filter((name) => !ignored.has(name) && !engineMethods.has(name));
    assert.ok(toCheck.length >= 8, `only ${toCheck.length} direct v86 calls found — check the scan`);
    for (const method of toCheck) {
        assert.ok(bundle.includes(`${method}=function`) || bundle.includes(method), `libv86.js has no ${method}`);
    }
});

test("the app never uses root-absolute URLs (GitHub Pages project sites live in a sub-path)", () => {
    const offenders = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(offenders, [], `root-absolute paths break under /<repo>/ on GitHub Pages: ${offenders.join(", ")}`);
    for (const module of ["app/app.js", "app/engine.js", "app/sources.js", "app/iso9660.js"]) {
        const source = read(module);
        assert.ok(!/from "\/[^.]/.test(source), `${module} imports from a root-absolute path`);
    }
});

test("everything the page references is on disk", () => {
    const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((url) => !/^(https?:|data:|#|mailto:)/.test(url));
    for (const ref of localRefs) {
        assert.ok(fs.existsSync(path.join(ROOT, ref)), `index.html references missing file ${ref}`);
    }
});

test("the documentation linked from the footer exists", () => {
    const docs = [...html.matchAll(/data-repo-path="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(docs.length >= 4, "expected several documentation links");
    for (const doc of docs) {
        assert.ok(fs.existsSync(path.join(ROOT, doc)), `missing ${doc}`);
    }
});

test("GitHub Pages plumbing is in place", () => {
    assert.ok(fs.existsSync(path.join(ROOT, ".nojekyll")), ".nojekyll keeps Jekyll out of the way");

    const workflow = read(".github/workflows/pages.yml");
    assert.match(workflow, /upload-pages-artifact/);
    assert.match(workflow, /deploy-pages/);
    assert.match(workflow, /pages:\s*write/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /branches:\s*\[?\s*main/, "the workflow should deploy the default branch");
});

test("the v86 screen contract is respected by the markup and the stylesheet", () => {
    const start = html.indexOf('<div id="screen_container">');
    assert.ok(start > 0, "#screen_container is missing");
    const snippet = html.slice(start, start + 400);
    const textDiv = snippet.indexOf("<div class=\"screen-text\"");
    const canvas = snippet.indexOf("<canvas");
    assert.ok(textDiv > 0, "v86 needs a text-mode <div> inside the container");
    assert.ok(canvas > 0, "v86 needs a <canvas> for graphical mode");
    assert.ok(textDiv < canvas, "the text div must come before the canvas");
    assert.match(css, /white-space:\s*pre/, "the text screen needs white-space: pre");
    assert.match(css, /#screen_container:fullscreen/, "v86 fullscreens #screen_container itself");
});
