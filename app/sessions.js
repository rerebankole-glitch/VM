/**
 * One explicitly saved, bounded browser snapshot. No autosaving, no ISO cache.
 * Metadata is separate so the welcome screen never loads a large RAM image.
 */
import { getEntry } from "./catalog.js";
import { canStream } from "./sources.js";
import { VmEngine } from "./engine.js";

export const SESSION_LIMIT_BYTES = 128 * 1024 * 1024;
const DB_NAME = "webvm-session-v1";
const SLOT = "last";

export function canRememberSession(active) {
    return Boolean(active && active.diskMode === "none" && (active.source?.kind === "bundled"
        || (active.source?.kind === "url" && canStream(active.source))));
}

export function sessionMetadata(active, coreVersion, bytes, createdAt = Date.now()) {
    if (!canRememberSession(active)) {
        throw new Error("Browser resume needs a built-in or streamed image with no extra hard disk. Use Download state for a local ISO or installation.");
    }
    const { kind, label, sizeBytes, device, url, acceptRanges, bundledPath } = active.source;
    return {
        version: 1, osId: active.osId, coreVersion, bytes, createdAt,
        machine: { ...active.machine },
        source: { kind, label, sizeBytes, device, url, acceptRanges, bundledPath, streamOnly: kind === "url" },
    };
}

/** Treat stored metadata as untrusted; never boot a corrupted configuration. */
export function validateSession(metadata, coreVersion) {
    const entry = getEntry(metadata?.osId);
    if (entry?.filesystem) {
        throw new Error("This demand-loaded filesystem does not yet support browser-session restore. Start a fresh Linux desktop.");
    }
    if (metadata?.version !== 1 || !entry || metadata.coreVersion !== coreVersion) {
        throw new Error("This saved session belongs to a different emulator version or is invalid. Delete it and start a fresh machine.");
    }
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > SESSION_LIMIT_BYTES
        || !Number.isFinite(metadata.createdAt) || metadata.createdAt < 0) throw new Error("Invalid saved session size or date.");
    const machine = metadata.machine;
    if (!machine || !VmEngine.memoryChoices().includes(machine.memoryMB) || !VmEngine.vgaChoices().includes(machine.vgaMB)
        || !["auto", "cd", "floppy", "hdd"].includes(machine.bootOrder)
        || !["none", "inbrowser", "widgetry", "custom"].includes(machine.netBackend)
        || !["ne2k", "virtio"].includes(machine.nicType)
        || typeof machine.customRelayUrl !== "string"
        || ["acpi", "sound", "disableJit", "instantBoot"].some((key) => typeof machine[key] !== "boolean")) {
        throw new Error("The saved machine settings are invalid.");
    }
    const source = metadata.source;
    if (!source || typeof source.label !== "string" || source.device !== entry.device) throw new Error("The saved image configuration is invalid.");
    if (source.kind === "bundled") {
        if (!entry.bundled || source.url !== entry.bundled.path || source.sizeBytes !== entry.sizeBytes) {
            throw new Error("The bundled image has changed. Start a fresh machine.");
        }
    } else if (source.kind === "url" && canStream(source)) {
        let url;
        try { url = new URL(source.url, typeof location !== "undefined" ? location.href : "http://localhost/"); } catch { /* handled below */ }
        if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("The saved streaming URL is invalid.");
    } else {
        throw new Error("This session needs an image that cannot be reopened automatically.");
    }
    return metadata;
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Browser storage failed."));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("Browser storage transaction was cancelled."));
        transaction.onerror = () => {}; // onabort carries the final error
    });
}

export class SessionStore {
    constructor(options = {}) {
        try { this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB; }
        catch { this.indexedDB = null; } // sandboxed / third-party contexts can throw on access
        try { this.storage = options.storage === undefined ? globalThis.navigator?.storage : options.storage; }
        catch { this.storage = null; }
        this.opening = null;
    }

    get supported() { return Boolean(this.indexedDB); }

    async open() {
        if (!this.supported) throw new Error("Browser session storage is unavailable. You can still run the VM without saving.");
        if (!this.opening) {
            this.opening = new Promise((resolve, reject) => {
                const request = this.indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore("metadata");
                    request.result.createObjectStore("snapshots");
                };
                let blocked = false;
                request.onblocked = () => { blocked = true; reject(new Error("Another WebVM tab is blocking session storage. Close that tab and try again.")); };
                request.onerror = () => reject(request.error || new Error("Could not open browser storage."));
                request.onsuccess = () => {
                    const db = request.result;
                    if (blocked) { db.close(); return; }
                    db.onversionchange = () => { db.close(); this.opening = null; };
                    resolve(db);
                };
            }).catch((error) => { this.opening = null; throw error; });
        }
        return this.opening;
    }

    async summary() {
        const db = await this.open();
        return await requestResult(db.transaction("metadata").objectStore("metadata").get(SLOT)) || null;
    }

    async read() {
        const db = await this.open();
        const tx = db.transaction(["metadata", "snapshots"]);
        const [metadata, buffer] = await Promise.all([
            requestResult(tx.objectStore("metadata").get(SLOT)),
            requestResult(tx.objectStore("snapshots").get(SLOT)),
        ]);
        if (!metadata || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== metadata.bytes) {
            throw new Error("The saved session is missing or incomplete. Start a new machine.");
        }
        return { metadata, buffer };
    }

    async save(metadata, buffer) {
        if (!(buffer instanceof ArrayBuffer) || metadata.bytes !== buffer.byteLength || !buffer.byteLength
            || buffer.byteLength > SESSION_LIMIT_BYTES) {
            throw new Error("This snapshot exceeds the 128 MB browser-session limit. Use Download state, or a smaller guest.");
        }
        let estimate;
        try { estimate = await this.storage?.estimate?.(); } catch { /* the transaction still checks quota */ }
        if (estimate?.quota && estimate.quota - (estimate.usage || 0) < buffer.byteLength + 1024 * 1024) {
            throw new Error("Not enough free browser storage for this snapshot. Delete an older session or keep running without saving.");
        }
        const db = await this.open();
        const tx = db.transaction(["metadata", "snapshots"], "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("metadata").put(metadata, SLOT);
        tx.objectStore("snapshots").put(buffer, SLOT);
        try { await done; } catch (error) {
            if (error?.name === "QuotaExceededError") throw new Error("Browser storage is full. No session was saved; the VM is still available.");
            throw error;
        }
    }

    async clear() {
        const db = await this.open();
        const tx = db.transaction(["metadata", "snapshots"], "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("metadata").delete(SLOT);
        tx.objectStore("snapshots").delete(SLOT);
        await done;
    }
}
