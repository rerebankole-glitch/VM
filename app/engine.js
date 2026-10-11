/**
 * A thin, well-behaved wrapper around one v86 instance.
 *
 * The wrapper owns the emulator lifecycle (create → run → pause → reset →
 * destroy) and translates v86's bus events into a small set of callbacks, so
 * the UI layer never has to know v86's internals.
 */

export const WASM_PATH = "assets/v86/v86.wasm";
export const BIOS_IMAGE = { url: "assets/v86/seabios.bin" };
export const VGA_BIOS_IMAGE = { url: "assets/v86/vgabios.bin" };

/** v86 BootOrder values (see v86.d.ts). */
export const BOOT_ORDERS = [
    { id: "auto", label: "Automatic — let the BIOS decide", value: 0 },
    { id: "cd", label: "CD-ROM → floppy → hard disk", value: 0x213 },
    { id: "floppy", label: "Floppy → CD-ROM → hard disk", value: 0x231 },
    { id: "hdd", label: "Hard disk → CD-ROM → floppy", value: 0x132 },
];

/** Network adapters offered in the UI. */
export const NIC_TYPES = [
    { id: "ne2k", label: "NE2000 — best for DOS and older Linux" },
    { id: "virtio", label: "VirtIO — fastest for modern Linux" },
];

/**
 * Network backends. `inbrowser` needs no server at all; the widgetry relay is
 * the public proxy documented by v86 and is the quickest way to get a guest
 * onto the real internet.
 */
export const NET_BACKENDS = [
    { id: "none", label: "Guest internet off", help: "No guest internet relay. Built-in system files still load from this site; local guest loopback remains available." },
    {
        id: "inbrowser",
        label: "In-browser network",
        help: "v86's built-in LAN: DHCP/DNS and connections between tabs of this page. No internet.",
        relayUrl: "inbrowser",
    },
    {
        id: "widgetry",
        label: "Public relay (relay.widgetry.org)",
        help: "v86's community TCP relay — gives the guest real internet access, shared with other users.",
        relayUrl: "wss://relay.widgetry.org/",
    },
    {
        id: "custom",
        label: "Custom relay / proxy URL",
        help: "Point this at your own wsproxy or a fetch/WISP CORS proxy.",
        relayUrl: "",
    },
];

const MEMORY_CHOICES = [16, 32, 64, 128, 256, 512, 1024, 2048];
const VGA_CHOICES = [2, 4, 8, 16, 32];

/** @typedef {"idle"|"loading"|"ready"|"running"|"paused"|"error"|"stopped"} EngineState */

export class VmEngine {
    /**
     * @param {object} options
     * @param {HTMLElement} options.container  the #screen_container element
     * @param {object} [options.hooks]
     * @param {(state: EngineState, detail?: object) => void} [options.hooks.onState]
     * @param {(info: object) => void} [options.hooks.onProgress]
     * @param {(message: string, level?: string) => void} [options.hooks.onLog]
     * @param {(width: number, height: number, bpp: number) => void} [options.hooks.onScreenSize]
     */
    constructor({ container, hooks = {}, startupTimeoutMs = 45_000 }) {
        this.container = container;
        this.hooks = hooks;
        this.startupTimeoutMs = startupTimeoutMs;
        this.state = /** @type {EngineState} */ ("idle");
        this.lastError = null;
        this.keyboardEnabled = false;
        /** @type {any} */
        this.v86 = null;
        this.config = null;
        this.startedAt = 0;
        /** Resolves when v86 reports the core is initialised (or fails). */
        this.readyPromise = Promise.resolve();
        this.#readyResolve = null;
    }

    #readyResolve;

    static memoryChoices() {
        return MEMORY_CHOICES;
    }

    static vgaChoices() {
        return VGA_CHOICES;
    }

    /** True while the emulator object exists (even if paused). */
    get isAttached() {
        return Boolean(this.v86);
    }

    get isRunning() {
        return this.state === "running";
    }

    #setState(state, detail) {
        this.state = state;
        this.hooks.onState?.(state, detail);
    }

    #log(message, level = "info") {
        this.hooks.onLog?.(message, level);
    }

    /**
     * Boot a machine.
     *
     * @param {object} config
     * @param {object} config.image        v86 image descriptor ({url}, {buffer}, {buffer: File})
     * @param {string} config.device       "cdrom" | "fda" | "hda" | "fdb" | "hdb"
     * @param {number} config.memoryMB
     * @param {number} config.vgaMB
     * @param {number} config.bootOrder
     * @param {string} config.nicType
     * @param {string} config.relayUrl
     * @param {boolean} config.acpi
     * @param {boolean} config.sound
     * @param {boolean} config.disableJit
     * @param {object} [config.hardDisk] optional hda image ({buffer} or {buffer: File})
     * @param {boolean} [config.instantBoot] skip the BIOS boot menu
     * @param {Function} [config.onLog]
     */
    async boot(config) {
        if (this.v86) {
            await this.destroy();
        }
        if (!window.V86) {
            this.#setState("error", { message: "The emulator script (libv86.js) did not load." });
            throw new Error("libv86.js is missing — run `npm run vendor` or check assets/v86/.");
        }

        this.config = config;
        this.lastError = null;
        this.#setState("loading", { message: "Starting the emulator core…" });
        this.#log(`Preparing virtual machine: ${config.memoryMB} MB RAM, ${config.vgaMB} MB video.`);
        this.readyPromise = new Promise((resolve) => {
            this.#readyResolve = resolve;
        });

        const options = {
            wasm_path: WASM_PATH,
            memory_size: config.memoryMB * 1024 * 1024,
            vga_memory_size: config.vgaMB * 1024 * 1024,
            screen_container: this.container,
            bios: BIOS_IMAGE,
            vga_bios: VGA_BIOS_IMAGE,
            // Keep a cancelled / failed boot from starting an orphan CPU later.
            // The wrapper starts it explicitly once this instance is still current.
            autostart: false,
            boot_order: config.bootOrder,
            acpi: Boolean(config.acpi),
            disable_speaker: !config.sound,
            disable_keyboard: false,
            disable_mouse: false,
            disable_jit: Boolean(config.disableJit),
            fastboot: Boolean(config.instantBoot),
        };

        if (config.filesystem) {
            options.filesystem = config.filesystem;
            options.bzimage_initrd_from_filesystem = true;
            options.cmdline = config.cmdline;
        } else {
            const deviceKey = config.device || "cdrom";
            options[deviceKey] = config.image;
        }
        if (config.hardDisk) {
            options.hda = config.hardDisk;
        }

        if (config.network !== false && config.relayUrl) {
            options.net_device = {
                type: config.nicType || "ne2k",
                relay_url: config.relayUrl,
            };
        }

        try {
            this.v86 = new window.V86(options);
        } catch (error) {
            this.lastError = error;
            this.#readyResolve?.();
            this.#setState("error", { message: describeError(error), error });
            this.#log(describeError(error), "error");
            throw error;
        }

        this.setKeyboardEnabled(false);
        this.setMouseEnabled(false);
        this.#attachEventBridge();
        const instance = this.v86;
        this.startedAt = performance.now();
        const deadline = setTimeout(() => {
            if (this.v86 !== instance || this.state !== "loading") return;
            this.lastError = new Error("The emulator could not initialize in time. Check the image host or try a built-in system.");
            this.#setState("error", { message: this.lastError.message });
            this.#readyResolve?.();
        }, this.startupTimeoutMs);
        try {
            await this.#readyInstance();
            if (config.autostart !== false) await this.run();
            return instance;
        } finally { clearTimeout(deadline); }
    }

    #attachEventBridge() {
        const v86 = this.v86;
        if (!v86?.add_listener) return;
        const on = (event, callback) => v86.add_listener(event, (...args) => {
            if (this.v86 === v86) callback(...args);
        });

        on("emulator-ready", () => {
            this.#log("Emulator core ready. ROMs loaded, starting the guest BIOS.", "ok");
            this.setKeyboardEnabled(false);
            this.setMouseEnabled(false);
            this.#readyResolve?.();
            if (this.state === "loading") this.#setState("ready");
        });

        on("emulator-loaded", () => {
            this.#log("All disk images are attached.", "ok");
        });

        on("emulator-started", () => {
            this.#setState("running");
        });

        on("emulator-stopped", () => {
            this.#setState("paused");
        });

        on("download-progress", (event) => {
            this.hooks.onProgress?.({
                loaded: event.loaded,
                total: event.total,
                lengthComputable: event.lengthComputable,
                fileName: event.file_name,
                fileIndex: event.file_index,
                fileCount: event.file_count,
            });
        });

        on("download-error", (event) => {
            const name = event.file_name || "disk image";
            this.lastError = new Error(`Could not load ${name}.`);
            this.#log(`Failed to download ${name}.`, "error");
            this.#setState("error", { message: this.lastError.message });
            this.#readyResolve?.();
        });

        on("screen-set-size", (size) => {
            const [width, height, bpp] = size;
            this.hooks.onScreenSize?.(width, height, bpp);
        });
    }

    async #readyInstance() {
        const instance = this.v86;
        if (!instance) throw new Error("No virtual machine is attached.");
        await this.readyPromise;
        if (this.v86 !== instance) throw new Error("The boot was cancelled.");
        if (this.state === "error") throw this.lastError || new Error("The emulator could not initialize.");
        return instance;
    }

    /** Start / resume execution. */
    async run() {
        if (!this.v86) throw new Error("Nothing to run yet.");
        // v86 only creates its internal CPU once the ROMs and the WASM core are
        // loaded; calling run() earlier throws inside v86, so wait for it.
        const instance = await this.#readyInstance();
        await instance.run();
    }

    /** Pause execution (the tab stays alive, nothing is lost). */
    async pause() {
        if (!this.v86) return;
        await this.v86.stop();
    }

    /** Reboot the virtual machine (back to the BIOS splash). */
    async reset() {
        if (!this.v86) return;
        this.#log("Rebooting the virtual machine…");
        await this.v86.restart();
    }

    /** Tear everything down and free the WASM memory. */
    async destroy() {
        const v86 = this.v86;
        this.v86 = null;
        this.#readyResolve?.();
        this.#readyResolve = null;
        this.startedAt = 0;
        if (!v86) {
            this.#setState("idle");
            return;
        }
        try {
            await v86.destroy();
        } catch (error) {
            this.#log(`Cleanup warning: ${describeError(error)}`, "warn");
        }
        this.#setState("idle");
    }

    setKeyboardEnabled(enabled) {
        this.keyboardEnabled = Boolean(enabled);
        try {
            this.v86?.keyboard_set_enabled?.(enabled);
        } catch {
            /* ignore */
        }
    }

    setMouseEnabled(enabled) {
        try {
            this.v86?.mouse_set_enabled?.(enabled);
        } catch {
            /* ignore */
        }
    }

    /** Release modifier keys the guest may still think are held down. */
    releaseModifiers() {
        const releases = [0xaa, 0xb6, 0x9d, 0xe0, 0x9d, 0xb8, 0xe0, 0xb8];
        try {
            this.v86?.keyboard_send_scancodes?.(releases);
        } catch {
            /* ignore */
        }
    }

    /** Send Ctrl+Alt+Delete to the guest (login managers, DOS reboots…). */
    sendCtrlAltDel() {
        this.#log("Sending Ctrl+Alt+Delete to the guest…");
        try {
            this.v86?.keyboard_send_scancodes?.([0x1d, 0x38, 0x53, 0x9d, 0xb8, 0xd3]);
        } catch (error) {
            this.#log(describeError(error), "warn");
        }
    }

    /**
     * Reviewed, US-ASCII keystrokes (not a shared clipboard). v86's text API
     * silently ignores input while its keyboard adapter is disabled. Enable
     * it only for each synchronous injection, never while host events run;
     * yielding between characters also prevents overflow of the guest PS/2 FIFO.
     */
    async sendText(text) {
        if (!text) return;
        const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
        if (normalized.length > 5000) throw new Error("Send at most 5,000 characters at a time; this path types keystrokes into the guest.");
        if (/[^\x08\x0a\x20-\x7e]/.test(normalized)) throw new Error("This keyboard path supports US-ASCII only. Non-ASCII text was not sent.");
        const instance = await this.#readyInstance();
        if (!this.isRunning) throw new Error("Resume the guest before sending text.");
        this.releaseModifiers();
        // Let the guest finish processing modifier releases / keyboard ACKs
        // before the first character (otherwise some guests drop that key).
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const character of normalized) {
            if (this.v86 !== instance || !this.isRunning) throw new Error("Text sending stopped because the guest is no longer running.");
            const wasEnabled = this.keyboardEnabled;
            let pending;
            try {
                this.setKeyboardEnabled(true);
                pending = instance.keyboard_send_text(character);
            } finally { this.setKeyboardEnabled(wasEnabled); }
            await pending;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        this.#log(`Typed ${normalized.length} character(s) into the guest${text.includes("\t") ? " (tabs expanded to four spaces)" : ""}.`);
    }

    /** @returns {string|null} a PNG data URL */
    screenshot() {
        try {
            const image = this.v86?.screen_make_screenshot?.();
            return image?.src || null;
        } catch (error) {
            this.#log(`Screenshot failed: ${describeError(error)}`, "warn");
            return null;
        }
    }

    /** Ask the browser for pointer lock (must be called from a user gesture). */
    async lockMouse(target = this.container) {
        if (!target?.requestPointerLock) throw new Error("Mouse capture is not supported by this browser.");
        try {
            await target.requestPointerLock({ unadjustedMovement: true });
        } catch {
            // Some browsers support pointer lock but not raw mouse movement.
            await target.requestPointerLock();
        }
    }

    goFullscreen() {
        this.v86?.screen_go_fullscreen?.();
    }

    /** Emulated instructions since boot — used to show a rough MIPS figure. */
    instructionCounter() {
        try {
            return this.v86?.get_instruction_counter?.() ?? 0;
        } catch {
            return 0;
        }
    }

    uptimeMs() {
        return this.startedAt ? performance.now() - this.startedAt : 0;
    }

    /**
     * Save the full machine state (CPU, RAM, disks, screen) as a
     * buffer that can be restored later.
     * @returns {Promise<ArrayBuffer>}
     */
    async saveState() {
        if (!this.v86) throw new Error("Boot the machine before saving its state.");
        const instance = await this.#readyInstance();
        const wasRunning = this.isRunning;
        this.#log("Saving machine state — large machines take a few seconds…");
        try {
            if (wasRunning) await this.pause();
            const state = await instance.save_state();
            this.#log(`State saved (${Math.round(state.byteLength / 1024 / 1024)} MB).`, "ok");
            return state;
        } finally {
            if (wasRunning && this.v86 === instance) await this.run();
        }
    }

    /** @param {ArrayBuffer} state */
    async restoreState(state) {
        if (!this.v86) throw new Error("Boot the machine before restoring a state.");
        const instance = await this.#readyInstance();
        const wasRunning = this.isRunning;
        try {
            if (wasRunning) await this.pause();
            await instance.restore_state(state);
            this.#log("State restored.", "ok");
        } finally {
            if (wasRunning && this.v86 === instance) await this.run();
        }
    }

    /** Attach a different CD-ROM/disc while the machine runs. */
    async setImage(device, image) {
        if (!this.v86) throw new Error("Nothing to attach to.");
        const method = { cdrom: "set_cdrom", fda: "set_fda", fdb: "set_fdb" }[device];
        if (!method) throw new Error(`Cannot hot-swap ${device}.`);
        await this.v86[method](image);
        this.#log(`Inserted a new image into ${device}.`);
    }

    eject(device) {
        const method = { cdrom: "eject_cdrom", fda: "eject_fda", fdb: "eject_fdb" }[device];
        try {
            if (method) this.v86?.[method]?.();
        } catch {
            /* ignore */
        }
    }
}

/** Turn any thrown value into something worth showing a human. */
export function describeError(error) {
    if (!error) return "Unknown error.";
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}
