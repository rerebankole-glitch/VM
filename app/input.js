/**
 * A VM is a focused application, not a hover target. v86's listeners are
 * global, so keep them disabled whenever host controls have focus.
 */
export class ScreenInput {
    constructor({ engine, viewport, document, window, onChange = () => {}, onFullscreen = () => {} }) {
        Object.assign(this, { engine, viewport, document, window, onChange, onFullscreen });
        this.captured = false;
        this.listeners = [];
        const on = (target, type, callback, options) => {
            target.addEventListener(type, callback, options);
            this.listeners.push(() => target.removeEventListener(type, callback, options));
        };
        on(viewport, "pointerdown", () => this.capture());
        on(viewport, "focus", () => this.capture());
        on(document, "pointerdown", (event) => {
            if (!viewport.contains(event.target)) this.release();
        }, true);
        on(document, "focusin", (event) => {
            if (!viewport.contains(event.target)) this.release();
        });
        on(window, "blur", () => this.release());
        on(document, "visibilitychange", () => { if (document.hidden) this.release(); });
        on(document, "pointerlockchange", () => {
            if (document.pointerLockElement === viewport) this.capture();
            else if (this.captured) this.release();
        });
        on(viewport, "contextmenu", (event) => { if (this.captured) event.preventDefault(); });
        on(viewport, "wheel", (event) => { if (this.captured) event.preventDefault(); }, { passive: false });
        // Capture phase runs before v86's global listeners. Host shortcuts must
        // never leak a half-pressed modifier or duplicate Ctrl+Alt+Delete.
        on(document, "keydown", (event) => {
            if (!this.captured || !event.ctrlKey || !event.altKey) return;
            const key = event.key.toLowerCase();
            if (!["g", "f", "delete", "backspace"].includes(key)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (key === "g") this.release();
            else if (key === "f") { this.release(); this.onFullscreen(); }
            else if (!event.repeat) { this.engine.releaseModifiers(); this.engine.sendCtrlAltDel(); }
        }, true);
        this.update();
    }

    capture() {
        if (!this.engine.isRunning) return;
        this.captured = true;
        this.engine.setKeyboardEnabled(true);
        this.engine.setMouseEnabled(true);
        if (this.document.activeElement !== this.viewport) this.viewport.focus({ preventScroll: true });
        this.update();
    }

    release() {
        const wasCaptured = this.captured;
        this.captured = false;
        if (wasCaptured) this.engine.releaseModifiers();
        this.engine.setKeyboardEnabled(false);
        this.engine.setMouseEnabled(false);
        if (this.document.pointerLockElement === this.viewport) this.document.exitPointerLock?.();
        this.update();
    }

    async grabMouse() {
        if (!this.engine.isRunning) return;
        this.capture();
        await this.engine.lockMouse(this.viewport);
        this.update();
    }

    update() {
        const locked = this.document.pointerLockElement === this.viewport;
        this.viewport.classList.toggle("is-capturing", this.captured);
        this.viewport.classList.toggle("is-pointer-locked", locked);
        this.onChange({ captured: this.captured, locked });
    }

    destroy() {
        this.release();
        this.listeners.forEach((remove) => remove());
        this.listeners = [];
    }
}
