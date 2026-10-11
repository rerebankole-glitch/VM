import test from "node:test";
import assert from "node:assert/strict";
import { ScreenInput } from "../app/input.js";

function event(type, target, values = {}) {
    const result = new Event(type, { cancelable: true });
    if (target) Object.defineProperty(result, "target", { value: target });
    Object.assign(result, values);
    return result;
}
function fixture() {
    const document = new EventTarget(), window = new EventTarget(), viewport = new EventTarget();
    const classes = new Set();
    viewport.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } };
    viewport.contains = (element) => element === viewport;
    viewport.focus = () => { document.activeElement = viewport; viewport.dispatchEvent(new Event("focus")); };
    document.exitPointerLock = () => { document.pointerLockElement = null; document.dispatchEvent(new Event("pointerlockchange")); };
    const engine = {
        isRunning: true, keyboard: false, mouse: false, releases: 0, cad: 0, lockTarget: null,
        setKeyboardEnabled(value) { this.keyboard = value; },
        setMouseEnabled(value) { this.mouse = value; },
        releaseModifiers() { this.releases++; },
        sendCtrlAltDel() { this.cad++; },
        async lockMouse(target) { this.lockTarget = target; document.pointerLockElement = target; document.dispatchEvent(new Event("pointerlockchange")); },
    };
    let fullscreen = 0;
    const input = new ScreenInput({ engine, viewport, document, window, onFullscreen: () => fullscreen++ });
    return { input, engine, viewport, document, window, classes, fullscreen: () => fullscreen };
}

test("hover is not keyboard capture; a display click explicitly connects input", () => {
    const f = fixture();
    f.viewport.dispatchEvent(new Event("pointerenter"));
    assert.equal(f.input.captured, false);
    assert.equal(f.engine.keyboard, false);
    f.viewport.dispatchEvent(new Event("pointerdown"));
    assert.equal(f.input.captured, true);
    assert.equal(f.engine.keyboard, true);
    assert.equal(f.engine.mouse, true);
    assert.equal(f.document.activeElement, f.viewport);
    assert.equal(f.classes.has("is-capturing"), true);
    f.input.destroy();
});

test("pointer movement alone never loses focused guest keys, even under pointer lock", async () => {
    const f = fixture();
    await f.input.grabMouse();
    f.viewport.dispatchEvent(new Event("pointerleave"));
    assert.equal(f.input.captured, true);
    assert.equal(f.engine.lockTarget, f.viewport);
    assert.equal(f.classes.has("is-pointer-locked"), true);
    f.document.pointerLockElement = null; // native Esc
    f.document.dispatchEvent(new Event("pointerlockchange"));
    assert.equal(f.input.captured, false);
    assert.equal(f.engine.keyboard, false);
    f.input.destroy();
});

for (const type of ["pointerdown", "focusin"]) {
    test(`host ${type} releases adapters and modifier keys`, () => {
        const f = fixture();
        f.input.capture();
        const before = f.engine.releases;
        f.document.dispatchEvent(event(type, { nodeName: "SELECT" }));
        assert.equal(f.input.captured, false);
        assert.equal(f.engine.keyboard, false);
        assert.equal(f.engine.mouse, false);
        assert.ok(f.engine.releases > before);
        f.input.destroy();
    });
}

test("window blur and document hiding cannot leave guest modifiers stuck", () => {
    const f = fixture();
    f.input.capture();
    f.window.dispatchEvent(new Event("blur"));
    assert.equal(f.input.captured, false);
    f.input.capture();
    f.document.hidden = true;
    f.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(f.input.captured, false);
    assert.equal(f.engine.keyboard, false);
    f.input.destroy();
});

test("Ctrl+Alt+G is a host release shortcut, not a guest command", () => {
    const f = fixture();
    f.input.capture();
    const shortcut = event("keydown", f.viewport, { key: "G", ctrlKey: true, altKey: true });
    f.document.dispatchEvent(shortcut);
    assert.equal(shortcut.defaultPrevented, true);
    assert.equal(f.input.captured, false);
    f.input.destroy();
});

test("host shortcuts do not hijack page forms, and guest CAD is sent once", () => {
    const f = fixture();
    const host = event("keydown", {}, { key: "Delete", ctrlKey: true, altKey: true });
    f.document.dispatchEvent(host);
    assert.equal(host.defaultPrevented, false);
    assert.equal(f.engine.cad, 0);
    f.input.capture();
    const guest = event("keydown", f.viewport, { key: "Delete", ctrlKey: true, altKey: true });
    f.document.dispatchEvent(guest);
    f.document.dispatchEvent(event("keydown", f.viewport, { key: "Delete", ctrlKey: true, altKey: true, repeat: true }));
    assert.equal(f.engine.cad, 1);
    assert.equal(guest.defaultPrevented, true);
    f.document.dispatchEvent(event("keydown", f.viewport, { key: "f", ctrlKey: true, altKey: true }));
    assert.equal(f.fullscreen(), 1);
    assert.equal(f.input.captured, false);
    f.input.destroy();
});

test("paused guests cannot capture input, and disposing removes all listeners", () => {
    const f = fixture();
    f.engine.isRunning = false;
    f.input.capture();
    assert.equal(f.input.captured, false);
    f.input.destroy();
    f.engine.isRunning = true;
    f.viewport.dispatchEvent(new Event("pointerdown"));
    assert.equal(f.input.captured, false);
});
