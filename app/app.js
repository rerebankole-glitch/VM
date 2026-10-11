/**
 * The application layer: everything the user sees and clicks.
 *
 * Flow: pick an operating system → point at a disk image (built-in, local
 * file, or URL) → adjust the virtual hardware → start. The engine module does
 * the emulation, this module never touches v86 directly except through it.
 */

import { CATALOG, RELAY_IDS, UNSUPPORTED, getEntry } from "./catalog.js";
import { extractLiveLinux } from "./iso9660.js";
import {
    BOOT_ORDERS, NET_BACKENDS, NIC_TYPES, VmEngine, describeError,
    WASM_PATH, WASM_PATH_64, LIBV86_PATH, LIBV86_PATH_64,
} from "./engine.js";
import {
    RAM_LIMIT_BYTES, bundledSource, canStream, describeSource, probeUrl, readFileToArrayBuffer, resolveImage,
} from "./sources.js";
import {
    clamp, downloadBlob, escapeHtml, fmtBytes, fmtDuration, fmtNumber, fileNameFromUrl,
    readStoredJson, readStoredString, shortenUrl, storeJson, storeString,
} from "./util.js";

import { ScreenInput } from "./input.js";
import { SessionStore, SESSION_LIMIT_BYTES, canRememberSession, sessionMetadata, validateSession } from "./sessions.js";

const UI_KEY = "webvm.preferences.v1";
const SETTINGS_KEY = "browser-vm.settings.v1";
const REPO_URL = "https://github.com/rerebankole-glitch/VM";

/** @type {HTMLElement} */
const $ = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/* ------------------------------------------------------------------ *
 * Application state
 * ------------------------------------------------------------------ */

const defaults = () => ({
    memoryMB: 128,
    vgaMB: 8,
    bootOrder: "auto",
    nicType: "ne2k",
    netBackend: "none",
    customRelayUrl: "",
    acpi: false,
    sound: false,
    disableJit: false,
    instantBoot: true,
    diskMode: "auto",
});

const state = {
    /** @type {string} */
    selectedId: "alpine-browser",
    /** Which sidebar step is showing: "os" | "disk" | "machine". */
    tab: "os",
    /** @type {import("./sources.js").DiskSource|null} */
    source: null,
    sourceTab: "builtin",
    machine: { ...defaults(), ...readStoredJson(SETTINGS_KEY, {}) },
    fit: true,
    zoom: 1,
    busy: false,
    sourceBusy: false,
    sessionBusy: false,
    active: null,
    sessionSummary: null,
    coreVersion: "",
    longMode: false,
    ui: { desktopMode: false, streamOnly: true, ...readStoredJson(UI_KEY, {}) },
    bootStartedAt: 0,
    /** @type {any} */
    lastState: null,
    /** @type {any} */
    probe: null,
    /** Optional second disk: { mode: "none"|"new"|"file", sizeMB, file, buffer } */
    disk: { mode: "none", sizeMB: 512, file: null, buffer: null },
};

const engine = new VmEngine({
    container: $("#screen_container"),
    hooks: {
        onState: handleEngineState,
        onLog: log,
        onProgress: handleProgress,
        onScreenSize: () => scheduleFit(),
        onSerial: handleSerialByte,
    },
});

let screenInput = null;
let streamController = null;
const sessionStore = new SessionStore();
let versionPromise = null;
let emulatorKind = "v86";

persistableDefaultsFix();

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function probeLongMode() {
    for (const url of ["assets/v86_64/VERSION", "assets/v86_64/v86.wasm"]) {
        try {
            const response = await fetch(url, { method: "HEAD", cache: "no-store" });
            if (response.ok) return true;
        } catch { /* static hosts may reject HEAD */ }
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (response.ok) return true;
        } catch { /* missing */ }
    }
    return false;
}

function loadEmulatorScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureEmulator(kind) {
    if (emulatorKind === kind && window.V86) return;
    const src = kind === "v86_64" ? LIBV86_PATH_64 : LIBV86_PATH;
    await loadEmulatorScript(src);
    if (!window.V86) throw new Error("The emulator script loaded but did not export V86.");
    emulatorKind = kind;
}

async function init() {
    state.longMode = await probeLongMode();
    buildOsList();
    buildBlockedList();
    buildDiskPanel();
    buildMachinePanel();
    bindStepTabs();
    bindScreenInteractions();
    bindToolbar();
    bindDesktopControls();
    bindDialogs();
    bindSessions();

    const remembered = readStoredString("browser-vm.last-os");
    selectOs(getEntry(remembered) ? remembered : state.selectedId, { silent: true });
    applyMachineToForm();
    setSourceTab(state.sourceTab);
    $("#stream-only").checked = state.ui.streamOnly !== false;
    setDesktopMode(Boolean(state.ui.desktopMode), { persist: false });
    setStatus("idle");
    log("Ready. Start the desktop or choose a system. Click its screen to control it.", "ok");
    if (state.longMode) log("64-bit emulator core found in assets/v86_64/.", "ok");
    else log("64-bit CPU demo needs libv86.js + v86.wasm in assets/v86_64/ (see that folder’s README).");
    log("Local files are never uploaded. Remote images can stream; the guest CPU and RAM still run in this browser.");
    updateFooterInfo();
    refreshSavedSession();
    refreshControls();
    const clock = () => { $("#desktop-clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    clock();
    window.setInterval(clock, 30_000);
}

/* ------------------------------------------------------------------ *
 * Sidebar steps (1 System → 2 Disk image → 3 Hardware)
 * ------------------------------------------------------------------ */

const STEP_NAMES = { os: "System", disk: "Disk image", machine: "Hardware" };

/** Show one sidebar step and mark its button as the active tab. */
function setTab(name, { silent = false } = {}) {
    state.tab = name;
    $$("[data-tab]").forEach((button) => {
        const active = button.dataset.tab === name;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$("[data-panel]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.panel === name);
    });
    if (!silent) {
        const step = Object.keys(STEP_NAMES).indexOf(name) + 1;
        log(`Step ${step}: ${STEP_NAMES[name]}.`);
    }
}

function bindStepTabs() {
    $$("[data-tab]").forEach((button) => {
        button.addEventListener("click", () => setTab(button.dataset.tab));
    });
    $("#os-next").addEventListener("click", () => setTab("disk"));
    // The markup starts on step 1; this keeps state.tab in sync without a log line.
    setTab(state.tab, { silent: true });
}

/* ------------------------------------------------------------------ *
 * OS picker
 * ------------------------------------------------------------------ */

function buildOsList() {
    const list = $("#os-list");
    list.innerHTML = CATALOG.map((entry) => {
        const badges = [
            `<span class="badge arch">${escapeHtml(entry.arch)}</span>`,
            entry.status === "instant" ? `<span class="badge instant">built in</span>` : "",
            entry.requiresLongMode ? `<span class="badge ${state.longMode ? "instant" : "blocked"}">${state.longMode ? "64-bit CPU" : "needs 64-bit core"}</span>` : "",
            entry.browser ? `<span class="badge instant">${escapeHtml(entry.browser)}</span>` : "",
            entry.legacy ? `<span class="badge blocked">unsupported legacy</span>` : "",
            entry.status === "tricky" ? `<span class="badge slow">slow · experimental</span>` : "",
        ].filter(Boolean).join("");
        const size = entry.filesystem ? `${fmtBytes(entry.sizeBytes)} on demand` : entry.bundled ? fmtBytes(entry.sizeBytes) : `≈ ${fmtBytes(entry.sizeBytes)} ISO`;
        return `
        <button class="os-card" data-os="${entry.id}" type="button">
            <span class="os-card-head">
                <span class="os-name">${escapeHtml(entry.name)} <small>${escapeHtml(entry.version)}</small></span>
                <span class="os-size">${escapeHtml(size)}</span>
            </span>
            <span class="os-sub">${escapeHtml(entry.family)} · ${escapeHtml(entry.desktop)} ${badges}</span>
            <span class="os-summary">${escapeHtml(entry.summary)}</span>
        </button>`;
    }).join("");

    list.addEventListener("click", (event) => {
        const card = /** @type {HTMLElement} */ (event.target).closest(".os-card");
        if (card) selectOs(card.dataset.os);
    });
}

function buildBlockedList() {
    $("#blocked-list").innerHTML = UNSUPPORTED.map((item) => `
        <li>
            <span class="blocked-name">${escapeHtml(item.name)}</span>
            <span class="badge blocked">${escapeHtml(item.arch)}</span>
            <span class="blocked-reason">${escapeHtml(item.reason)}</span>
        </li>`).join("");
}

function selectOs(id, { silent = false } = {}) {
    const entry = getEntry(id);
    if (!entry || engine.isAttached || state.busy || state.sourceBusy) return;
    const previousId = state.selectedId;
    state.selectedId = id;
    storeString("browser-vm.last-os", id);

    $$(".os-card").forEach((card) => {
        card.classList.toggle("is-selected", card.dataset.os === id);
    });

    // Recommend the machine settings for this guest, unless the user already
    // tuned them for this OS.
    if (!silent || !state.machine.tunedFor || state.machine.tunedFor !== id) {
        state.machine.memoryMB = entry.ramMB ?? state.machine.memoryMB;
        state.machine.vgaMB = entry.vgaMB ?? state.machine.vgaMB;
        state.machine.nicType = entry.nicType || (entry.status === "instant" && entry.family === "DOS" ? "ne2k" : state.machine.nicType);
        if (typeof entry.acpi === "boolean") state.machine.acpi = entry.acpi;
        if (entry.bootOrder) state.machine.bootOrder = entry.bootOrder;
        state.machine.tunedFor = id;
        applyMachineToForm();
    }

    if (entry.bundled) {
        state.source = bundledSource(entry);
        setSourceTab("builtin");
        state.sourceTab = "builtin";
    } else if (previousId !== id || state.source?.bundledPath) {
        state.source = null;
        setSourceTab("url");
    }

    renderSelection();
    renderDiskPanel();
}

function renderSelection() {
    const entry = getEntry(state.selectedId);
    if (!entry) return;
    $("#chosen-os").innerHTML = `
        <div class="chosen-head">
            <strong>${escapeHtml(entry.name)} ${escapeHtml(entry.version)}</strong>
            <span class="badge arch">${escapeHtml(entry.arch)}</span>
        </div>
        <p>${escapeHtml(entry.summary)}</p>`;

    const notes = $("#chosen-notes");
    notes.innerHTML = (entry.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("");

    const links = $("#chosen-links");
    if (entry.links?.length) {
        links.innerHTML = `
            <p class="hint">Stream a direct URL, or download an ISO only if you have the space:</p>
            ${linkRowHtml(entry)}`;
        links.hidden = false;
    } else {
        links.hidden = true;
    }

    renderDownloadBox(entry);
    updateStartHint();
}

/** The download links for one catalogue entry, as markup. */
function linkRowHtml(entry) {
    return `
        <div class="link-row">
            ${entry.links.map((link) => `
                <a class="link ${link.kind === "direct" ? "link-primary" : ""}"
                   href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
                    ${escapeHtml(link.label)}
                </a>`).join("")}
        </div>`;
}

/**
 * Step 1 shows where to get the ISO for the selected system. Bundled images
 * need no download, and it says so instead of leaving the user hunting for a
 * link that does not exist.
 */
function renderDownloadBox(entry) {
    const box = $("#os-download");
    if (entry.bundled) {
        box.className = "os-download is-ready";
        box.innerHTML = `
            <p class="os-download-title"><strong>${escapeHtml(entry.name)}</strong> ships with this page — no ISO to save.</p>
            <p class="hint">${entry.filesystem ? "The Linux kernel, desktop and Dillo are included. Files load from this site as needed; guest changes stay in RAM. Internet requires an optional relay." : "Its small image is already selected in step 2."} Press <strong>Boot</strong> whenever you like.</p>`;
    } else if (entry.links?.length) {
        box.className = "os-download is-download";
        box.innerHTML = `
            <p class="os-download-title"><strong>${escapeHtml(entry.name)} ${escapeHtml(entry.version)}</strong></p>
            ${entry.links.some((link) => link.kind === "direct") ? `<button class="btn primary" data-stream-os="${entry.id}" type="button">${streamButtonLabel(entry)}</button>` : ""}
            <p class="hint">Streaming needs verified byte ranges. If unavailable, it stops rather than saving a large ISO. Manual download links are below; local files are never uploaded.</p>
            ${linkRowHtml(entry)}`;
    } else {
        box.className = "os-download";
        box.innerHTML = `
            <p class="os-download-title">No download link recorded for <strong>${escapeHtml(entry.name)}</strong> yet.</p>
            <p class="hint">See “Which distros work” in the footer for where to get a 32-bit image.</p>`;
    }
    box.hidden = false;
}

function streamButtonLabel(entry) {
    if (entry.id === "mint-19.3-xfce-32") return "Explore Mint streaming…";
    if (entry.id.startsWith("ubuntu") || entry.id.startsWith("lubuntu")) return "Stream Ubuntu-family ISO…";
    return "Stream & boot (no ISO to save)";
}

const LEGACY_CONFIRM_IDS = new Set(["ubuntu-18.04.5-i386", "mint-19.3-xfce-32", "lubuntu-18.04.5-i386"]);

/* ------------------------------------------------------------------ *
 * Disk image panel
 * ------------------------------------------------------------------ */

function buildDiskPanel() {
    state.source = bundledSource(getEntry(state.selectedId));

    $$("[data-sourcetab]").forEach((button) => {
        button.addEventListener("click", () => setSourceTab(button.dataset.sourcetab));
    });

    // Built-in images
    $("#builtin-list").innerHTML = CATALOG.filter((entry) => entry.bundled).map((entry) => `
        <button class="builtin-card" data-builtin="${entry.id}" type="button">
            <span class="builtin-name">${escapeHtml(entry.name)}</span>
            <span class="builtin-meta">${fmtBytes(entry.sizeBytes)} · ${escapeHtml(entry.device)}</span>
            <span class="builtin-file">${escapeHtml(entry.bundled.fileName)}</span>
        </button>`).join("");

    $("#builtin-list").addEventListener("click", (event) => {
        const card = /** @type {HTMLElement} */ (event.target).closest("[data-builtin]");
        if (!card) return;
        selectOs(card.dataset.builtin);
    });

    // Local file: picker + drag & drop
    const fileInput = /** @type {HTMLInputElement} */ ($("#file-input"));
    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) useLocalFile(file);
    });

    const drop = $("#drop-zone");
    ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.remove("is-dragging");
    }));
    drop.addEventListener("drop", (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (file) useLocalFile(file);
    });

    // URL source. This preference is independent from local-file RAM handling.
    $("#stream-only").addEventListener("change", () => {
        state.ui.streamOnly = $("#stream-only").checked;
        storeJson(UI_KEY, state.ui);
        if (state.source?.kind === "url") state.source.streamOnly = state.ui.streamOnly;
        renderDiskPanel();
    });
    document.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-stream-os]");
        if (!button || button.disabled) return;
        if (LEGACY_CONFIRM_IDS.has(button.dataset.streamOs)) openLegacyDialog(button.dataset.streamOs);
        else streamCatalogImage(button.dataset.streamOs);
    });
    $("#url-use").addEventListener("click", () => useRemoteUrl());
    $("#url-check").addEventListener("click", () => checkUrl());
    $("#url-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            useRemoteUrl();
        }
    });
}

function setSourceTab(tab, { keepSource = false } = {}) {
    state.sourceTab = tab;
    $$("[data-sourcetab]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.sourcetab === tab);
    });
    $$("[data-sourcepanel]").forEach((panel) => {
        panel.hidden = panel.dataset.sourcepanel !== tab;
    });
    if (!keepSource) updateStartHint();
}

function useLocalFile(file) {
    state.source = {
        kind: "file",
        file,
        label: file.name,
        sizeBytes: file.size,
        device: "cdrom",
    };
    const note = file.size > RAM_LIMIT_BYTES && state.machine.diskMode === "ram"
        ? " (large file — streaming from disk is recommended)"
        : "";
    $("#file-chosen").innerHTML = `Selected: <strong>${escapeHtml(file.name)}</strong> · ${fmtBytes(file.size)}${note}`;
    $("#file-chosen").hidden = false;
    renderDiskPanel();
    renderSelection();
    log(`Disk image ready: ${file.name} (${fmtBytes(file.size)}).`);
}

async function checkUrl() {
    if (state.sourceBusy || state.busy || engine.isAttached) return null;
    const input = /** @type {HTMLInputElement} */ ($("#url-input"));
    const url = input.value.trim();
    const result = $("#url-result");
    if (!url) {
        result.innerHTML = `<p class="probe bad">Paste the direct link to an .iso first.</p>`;
        return null;
    }

    result.innerHTML = `<p class="probe">Checking ${escapeHtml(shortenUrl(url))} …</p>`;
    state.sourceBusy = true;
    refreshControls();
    let probe;
    try { probe = await probeUrl(url); }
    finally { state.sourceBusy = false; refreshControls(); }

    if (!probe.ok) {
        result.innerHTML = `
            <p class="probe bad">${escapeHtml(probe.error || "Could not read that URL.")}</p>
            <p class="hint">Tip: right-click the download button on the distro site → “Copy link address” usually gives a direct URL.</p>`;
        state.probe = null;
        return null;
    }

    const notes = [];
    notes.push(`Size: <strong>${probe.size ? fmtBytes(probe.size) : "unknown"}</strong>`);
    notes.push(probe.acceptRanges ? "Range requests: yes (streams only what is needed)" : "Range requests: no");
    if (probe.contentType) notes.push(`Type: ${escapeHtml(probe.contentType)}`);
    probe.notes.forEach((note) => notes.push(escapeHtml(note)));

    result.innerHTML = `<p class="probe ${canStream(probe) ? "ok" : "bad"}">${canStream(probe) ? "Streaming verified — no ISO file to save." : "Reachable, but streaming was not verified."}</p><ul class="probe-list">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>`;
    state.probe = { url, ...probe };
    return probe;
}

async function useRemoteUrl() {
    if (state.busy || state.sourceBusy || engine.isAttached) return;
    const url = $("#url-input").value.trim();
    const probe = state.probe?.url === /** @type {HTMLInputElement} */ ($("#url-input")).value.trim()
        ? state.probe
        : { url, ...await checkUrl() };
    if (!probe?.ok) return;
    if (state.ui.streamOnly && !canStream(probe)) {
        $("#url-result").insertAdjacentHTML("beforeend", `<p class="probe bad">Streaming-only mode refused this image. Nothing was downloaded. Use another host or the server relay.</p>`);
        return;
    }

    state.source = {
        kind: "url",
        url: probe.url,
        label: fileNameFromUrl(probe.url),
        sizeBytes: probe.size || 0,
        acceptRanges: probe.acceptRanges,
        streamOnly: state.ui.streamOnly !== false,
        device: "cdrom",
    };
    renderDiskPanel();
    renderSelection();
    log(`Remote image set: ${shortenUrl(probe.url)}`);
}

function renderDiskPanel() {
    const current = $("#source-current");
    if (!state.source) {
        current.innerHTML = `No disk image selected yet.`;
        current.classList.add("is-empty");
    } else {
        current.classList.remove("is-empty");
        const extra = state.source.kind === "file" && state.source.file?.size > RAM_LIMIT_BYTES
            ? `<span class="badge slow">large — streamed from disk</span>` : "";
        current.innerHTML = `<strong>${escapeHtml(describeSource(state.source))}</strong>
            <span class="os-size">${fmtBytes(state.source.sizeBytes)}</span> ${extra}`;
    }
    $$("[data-builtin]").forEach((card) => {
        card.classList.toggle("is-selected", card.dataset.builtin === state.selectedId);
    });
    updateStartHint();
    updateComputerDetails();
}

/* ------------------------------------------------------------------ *
 * Machine settings
 * ------------------------------------------------------------------ */

function buildMachinePanel() {
    $("#memory-select").innerHTML = VmEngine.memoryChoices()
        .map((mb) => `<option value="${mb}">${mb} MB</option>`).join("");
    $("#vga-select").innerHTML = VmEngine.vgaChoices()
        .map((mb) => `<option value="${mb}">${mb} MB</option>`).join("");
    $("#bootorder-select").innerHTML = BOOT_ORDERS
        .map((order) => `<option value="${order.id}">${escapeHtml(order.label)}</option>`).join("");
    $("#nic-select").innerHTML = NIC_TYPES
        .map((nic) => `<option value="${nic.id}">${escapeHtml(nic.label)}</option>`).join("");
    $("#net-select").innerHTML = NET_BACKENDS
        .map((net) => `<option value="${net.id}">${escapeHtml(net.label)}</option>`).join("");

    const bind = (selector, key, transform = (value) => value) => {
        const element = /** @type {HTMLInputElement|HTMLSelectElement} */ ($(selector));
        element.addEventListener("change", () => {
            const raw = element.type === "checkbox" ? element.checked : element.value;
            state.machine[key] = transform(raw);
            state.machine.tunedFor = state.selectedId;
            storeJson(SETTINGS_KEY, state.machine);
            renderMachineSummary();
            updateStartHint();
        });
    };

    bind("#memory-select", "memoryMB", Number);
    bind("#vga-select", "vgaMB", Number);
    bind("#bootorder-select", "bootOrder");
    bind("#nic-select", "nicType");
    bind("#net-select", "netBackend");
    bind("#relay-input", "customRelayUrl");
    bind("#toggle-acpi", "acpi");
    bind("#toggle-sound", "sound");
    bind("#toggle-safe", "disableJit");
    bind("#toggle-quickboot", "instantBoot");
    bind("#disk-mode", "diskMode");

    bindHardDiskControls();

    $("#net-select").addEventListener("change", () => {
        $("#quick-linux-internet").checked = state.machine.netBackend === "widgetry";
        updateRelayVisibility();
    });
    $("#reset-machine").addEventListener("click", () => {
        const entry = getEntry(state.selectedId);
        state.machine = {
            ...defaults(),
            memoryMB: entry?.ramMB ?? 128,
            vgaMB: entry?.vgaMB ?? 8,
            nicType: entry?.nicType || defaults().nicType,
            acpi: Boolean(entry?.acpi),
            bootOrder: entry?.bootOrder || "auto",
            tunedFor: state.selectedId,
        };
        storeJson(SETTINGS_KEY, state.machine);
        applyMachineToForm();
        log("Machine settings reset to the recommended values.");
    });
}

function bindHardDiskControls() {
    const select = /** @type {HTMLSelectElement} */ ($("#disk-select"));
    const sizeSelect = /** @type {HTMLSelectElement} */ ($("#disk-size"));
    const fileRow = $("#disk-file-row");
    const sizeRow = $("#disk-size-row");
    const fileInput = /** @type {HTMLInputElement} */ ($("#disk-file-input"));
    const note = $("#disk-note");

    const refresh = () => {
        state.disk.mode = select.value;
        state.disk.sizeMB = Number(sizeSelect.value);
        sizeRow.hidden = select.value !== "new";
        fileRow.hidden = select.value !== "file";
        $("#disk-download").disabled = !(state.disk.buffer || state.disk.file);
        note.textContent = {
            none: "No hard disk attached. Live images run entirely from the CD-ROM.",
            new: "The disk is created in RAM and can be downloaded afterwards to keep an installation.",
            file: "The whole image is loaded into RAM, so the guest can install onto it; download it again when you are done to keep the changes.",
        }[select.value];
        updateStartHint();
    };

    select.addEventListener("change", refresh);
    sizeSelect.addEventListener("change", refresh);
    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        state.disk.file = file;
        state.disk.buffer = null;
        $("#disk-note").textContent = `Disk image queued (${file.name}, ${fmtBytes(file.size)}) — it will be loaded into RAM before boot.`;
        $("#disk-download").disabled = false;
        updateStartHint();
    });

    $("#disk-download").addEventListener("click", () => {
        const { buffer, file } = state.disk;
        if (buffer) {
            downloadBlob(new Blob([buffer]), "vm-disk.img");
            log(`Disk image downloaded (${fmtBytes(buffer.byteLength)}). Attach it again with “Use a disk image file”.`, "ok");
        } else if (file) {
            downloadBlob(file, file.name);
            log("The untouched disk image was downloaded.", "ok");
        }
    });

    refresh();
}

function persistableDefaultsFix() {
    // Old/corrupt preferences and storage-denied contexts must not block boot.
    const fallback = defaults();
    const merged = { ...fallback, ...readStoredJson(SETTINGS_KEY, {}) };
    if (!VmEngine.memoryChoices().includes(merged.memoryMB)) merged.memoryMB = fallback.memoryMB;
    if (!VmEngine.vgaChoices().includes(merged.vgaMB)) merged.vgaMB = fallback.vgaMB;
    for (const [key, choices] of Object.entries({
        bootOrder: BOOT_ORDERS.map((item) => item.id), nicType: NIC_TYPES.map((item) => item.id),
        netBackend: NET_BACKENDS.map((item) => item.id), diskMode: ["auto", "ram", "stream"],
    })) { if (!choices.includes(merged[key])) merged[key] = fallback[key]; }
    for (const key of ["acpi", "sound", "disableJit", "instantBoot"]) {
        if (typeof merged[key] !== "boolean") merged[key] = fallback[key];
    }
    if (typeof merged.customRelayUrl !== "string") merged.customRelayUrl = "";
    state.machine = merged;
    state.ui.desktopMode = state.ui.desktopMode === true;
    state.ui.streamOnly = state.ui.streamOnly !== false;
}

function applyMachineToForm() {
    const machine = state.machine;
    /** @type {HTMLSelectElement} */ ($("#memory-select")).value = String(machine.memoryMB);
    /** @type {HTMLSelectElement} */ ($("#vga-select")).value = String(machine.vgaMB);
    /** @type {HTMLSelectElement} */ ($("#bootorder-select")).value = machine.bootOrder;
    /** @type {HTMLSelectElement} */ ($("#nic-select")).value = machine.nicType;
    /** @type {HTMLSelectElement} */ ($("#net-select")).value = machine.netBackend;
    /** @type {HTMLInputElement} */ ($("#relay-input")).value = machine.customRelayUrl || "";
    /** @type {HTMLInputElement} */ ($("#toggle-acpi")).checked = Boolean(machine.acpi);
    /** @type {HTMLInputElement} */ ($("#toggle-sound")).checked = Boolean(machine.sound);
    /** @type {HTMLInputElement} */ ($("#toggle-safe")).checked = Boolean(machine.disableJit);
    /** @type {HTMLInputElement} */ ($("#toggle-quickboot")).checked = machine.instantBoot !== false;
    /** @type {HTMLSelectElement} */ ($("#disk-mode")).value = machine.diskMode || "auto";
    $("#quick-linux-internet").checked = machine.netBackend === "widgetry";
    updateRelayVisibility();
    renderMachineSummary();
}

function updateRelayVisibility() {
    const backend = NET_BACKENDS.find((net) => net.id === state.machine.netBackend);
    const custom = state.machine.netBackend === "custom";
    $("#relay-row").hidden = !custom;
    $("#net-help").textContent = backend?.help || "";
}

function renderMachineSummary() {
    const machine = state.machine;
    const backend = NET_BACKENDS.find((net) => net.id === machine.netBackend);
    const bits = [
        `${machine.memoryMB} MB RAM`,
        `${machine.vgaMB} MB video`,
        backend ? backend.label : "network off",
    ];
    $("#machine-summary").textContent = bits.join(" · ");
}

/* ------------------------------------------------------------------ *
 * Screen, toolbar, input capture
 * ------------------------------------------------------------------ */

function bindScreenInteractions() {
    const viewport = $("#screen-viewport");
    screenInput = new ScreenInput({
        engine, viewport, document, window,
        onChange: ({ captured, locked }) => {
            document.body.dataset.input = captured ? "captured" : "released";
            $("#input-status").textContent = locked ? "Mouse captured · Esc to release" : captured ? "Keyboard & mouse connected" : "Controls released";
            $("#btn-release-input").disabled = !captured;
            $("#input-tip").hidden = !engine.isRunning || captured;
        },
        onFullscreen: toggleFullscreen,
    });
    $("#btn-grab-mouse").addEventListener("click", async () => {
        try { await screenInput.grabMouse(); } catch (error) { log(`Mouse capture unavailable: ${describeError(error)}. Click the display to keep using the guest.`, "warn"); }
    });
    $("#btn-release-input").addEventListener("click", () => screenInput.release());
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleFit).observe(viewport);
    window.addEventListener("resize", scheduleFit);
    document.addEventListener("fullscreenchange", () => {
        $("#btn-fullscreen").textContent = document.fullscreenElement ? "Exit fullscreen ↙" : "Fullscreen ↗";
        scheduleFit();
    });
}

function bindToolbar() {
    $("#btn-start").addEventListener("click", () => bootMachine());
    $("#btn-pause").addEventListener("click", async () => {
        if (engine.isRunning) {
            await engine.pause();
        } else if (engine.isAttached) {
            await engine.run();
        }
    });
    $("#btn-reset").addEventListener("click", async () => {
        if (!confirm("Restart this computer? Unsaved work in the guest may be lost.")) return;
        screenInput.release();
        try { await engine.reset(); } catch (error) { showError(describeError(error)); }
    });
    $("#btn-power").addEventListener("click", () => powerOff());
    $("#btn-fullscreen").addEventListener("click", () => toggleFullscreen());
    $("#btn-fit").addEventListener("click", () => {
        state.fit = true;
        scheduleFit();
        log("Screen scaled to fit the window.");
    });
    $("#btn-zoom-in").addEventListener("click", () => zoomBy(1.15));
    $("#btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.15));
    $("#btn-screenshot").addEventListener("click", () => {
        const dataUrl = engine.screenshot();
        if (!dataUrl) {
            log("Nothing to capture yet — start the machine first.", "warn");
            return;
        }
        fetch(dataUrl).then((response) => response.blob()).then((blob) => {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            downloadBlob(blob, `vm-screenshot-${stamp}.png`);
            log("Screenshot saved to your downloads folder.", "ok");
        }).catch((error) => log(`Screenshot could not be downloaded: ${describeError(error)}`, "warn"));
    });
    $("#btn-cad").addEventListener("click", () => engine.sendCtrlAltDel());
    $("#btn-enter").addEventListener("click", () => sendGuestEnter());
    $("#btn-state-save").addEventListener("click", () => saveState());
    $("#btn-state-load").addEventListener("click", () => $("#state-input").click());
    $("#state-input").addEventListener("change", (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const file = input.files?.[0];
        if (file) loadState(file);
        input.value = "";
    });
    $("#btn-type").addEventListener("click", () => openTypeBox());
    $("#btn-paste").addEventListener("click", async () => {
        openTypeBox();
        try {
            const text = await navigator.clipboard.readText();
            $("#type-input").value = text;
        } catch {
            log("Clipboard access was denied. Paste into the text box manually, then press Send text.", "warn");
        }
        $("#type-input").focus();
    });
    $("#type-close").addEventListener("click", () => { $("#type-box").hidden = true; $("#screen-viewport").focus(); });
    $("#type-send").addEventListener("click", async () => {
        if (state.sessionBusy || state.busy || !engine.isRunning) return;
        const input = $("#type-input");
        state.sessionBusy = true;
        screenInput.release();
        refreshControls();
        let sent = false;
        try {
            await engine.sendText(input.value);
            input.value = "";
            $("#type-box").hidden = true;
            sent = true;
        } catch (error) { sessionFeedback(`Text was not fully sent: ${describeError(error)}`, true); }
        finally { state.sessionBusy = false; refreshControls(); }
        if (sent) $("#screen-viewport").focus();
    });
    $("#type-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $("#type-send").click(); }
    });
    $("#error-dismiss").addEventListener("click", () => { $("#error-box").hidden = true; });
    $("#btn-clear-log").addEventListener("click", () => { $("#log-body").innerHTML = ""; });
}

function openTypeBox() {
    $("#tools-menu").open = false;
    screenInput.release();
    $("#type-box").hidden = false;
    $("#type-input").focus();
}

function zoomBy(factor) {
    state.fit = false;
    state.zoom = clamp(state.zoom * factor, 0.2, 6);
    applyZoom();
    $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

let fitQueued = false;
function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
        fitQueued = false;
        fitScreen();
    });
}

function fitScreen() {
    const child = visibleScreenChild();
    if (!child) return;
    const width = child.offsetWidth || 720;
    const height = child.offsetHeight || 400;

    if (state.fit) {
        const viewport = $("#screen-viewport");
        const availableW = Math.max(viewport.clientWidth - 16, 120);
        const availableH = Math.max(viewport.clientHeight - 16, 120);
        state.zoom = clamp(Math.min(availableW / width, availableH / height), 0.2, 4);
    }
    applyZoom(width, height);
    $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

/**
 * The stage holds the untransformed v86 screen; we scale it and centre it
 * inside the viewport ourselves so the layout is identical in fullscreen.
 */
function applyZoom(width, height) {
    const stage = $("#screen-stage");
    const child = visibleScreenChild();
    const w = width ?? child?.offsetWidth ?? 720;
    const h = height ?? child?.offsetHeight ?? 400;
    const viewport = $("#screen-viewport");
    const offsetX = Math.max(0, (viewport.clientWidth - w * state.zoom) / 2);
    const offsetY = Math.max(0, (viewport.clientHeight - h * state.zoom) / 2);
    stage.style.transform = `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px) scale(${state.zoom})`;
}

/** Fullscreen the whole screen area (not the whole page). */
async function toggleFullscreen() {
    const shell = $("#screen-shell");
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await shell.requestFullscreen();
        }
    } catch (error) {
        log(`Fullscreen was refused: ${describeError(error)}`, "warn");
    }
}

function visibleScreenChild() {
    const container = $("#screen_container");
    const canvas = container.querySelector("canvas");
    const text = container.querySelector("div");
    if (canvas && canvas.style.display !== "none" && canvas.offsetWidth) return canvas;
    if (text && text.offsetWidth) return text;
    return canvas || text;
}

/* ------------------------------------------------------------------ *
 * Booting
 * ------------------------------------------------------------------ */

function updateStartHint() {
    const button = /** @type {HTMLButtonElement} */ ($("#btn-start"));
    const entry = getEntry(state.selectedId);
    const ready = Boolean(state.source) && !state.busy && !state.sourceBusy && !state.sessionBusy && !engine.isAttached;
    button.disabled = !ready;
    $("#start-hint").textContent = !state.source
        ? "Step 2: choose a disk image"
        : state.busy
            ? "Working…"
            : `Boot ${entry ? entry.name : "computer"}`;

    // Point at step 2 while there is still nothing to boot from.
    const diskTab = /** @type {HTMLElement|null} */ (document.querySelector('[data-tab="disk"]'));
    diskTab?.classList.toggle("is-todo", !state.source);
}

function relayUrlFor(backendId, customUrl) {
    if (backendId === "none") return null;
    if (backendId === "custom") return (customUrl || "").trim() || null;
    return NET_BACKENDS.find((net) => net.id === backendId)?.relayUrl || null;
}

async function bootMachine({ desktop = false, restoreBuffer = null } = {}) {
    if (state.busy || state.sourceBusy || engine.isAttached) return;
    const entry = getEntry(state.selectedId);
    if (!state.source) {
        showError("Choose a disk image first.");
        return;
    }

    state.busy = true;
    state.bootStartedAt = performance.now();
    state.active = { osId: state.selectedId, source: { ...state.source }, machine: { ...state.machine }, diskMode: state.disk.mode };
    if (desktop) setDesktopMode(true);
    $("#error-box").hidden = true;
    $("#session-feedback").hidden = true;
    $("#boot-title").textContent = `${restoreBuffer ? "Restoring" : "Starting"} ${entry?.name || "your computer"}…`;
    $("#boot-description").textContent = state.source.kind === "filesystem"
        ? "Linux and Dillo load their files on demand. The local browser welcome page opens after the desktop starts."
        : state.source.kind === "url"
        ? "The image is streamed from its host. Your browser runs the virtual CPU and RAM."
        : "Loading the virtual hardware. The desktop will appear here.";
    setStatus("loading");
    refreshControls();
    setProgress(0, 1, "Preparing…");

    const machine = { ...state.machine };
    let bootOrder = BOOT_ORDERS.find((order) => order.id === machine.bootOrder)?.value ?? 0;
    if (bootOrder === 0 && state.disk.mode !== "none") {
        // With a disk attached, prefer the removable media so "boot the ISO,
        // then install to hda" works without touching the boot order.
        bootOrder = state.source.device === "fda" ? 0x231 : 0x213;
    }
    const relayUrl = relayUrlFor(machine.netBackend, machine.customRelayUrl);

    try {
        const want64 = entry?.emulator === "v86_64" || entry?.arch === "x86_64" || entry?.requiresLongMode;
        if (want64) {
            if (!state.longMode) {
                throw new Error("64-bit CPU files are missing. On your computer, download libv86.js, v86.wasm and v86-fallback.wasm from https://github.com/portlandhodl/v86_64/releases/tag/latest and put them in assets/v86_64/.");
            }
            await ensureEmulator("v86_64");
        } else {
            await ensureEmulator("v86");
        }
        log(`Booting ${entry ? `${entry.name} ${entry.version}` : "image"} as ${state.source.device}…`);
        const { image, filesystem, cmdline: fsCmdline, strategy } = await resolveImage(state.source, {
            mode: state.source.kind === "url" ? "auto" : machine.diskMode,
            streamOnly: state.source.kind === "url" && (state.source.streamOnly || state.ui.streamOnly),
            onProgress: (loaded, total, label) => {
                setProgress(loaded, total, `Loading ${label || "disk image"}…`);
            },
        });
        let cmdline = fsCmdline;
        let bzimage = null;
        let initrd = null;
        const canExtract = !restoreBuffer && !filesystem
            && state.source.device === "cdrom"
            && ((state.source.kind === "url" && canStream(state.source)) || (state.source.kind === "file" && state.source.file));
        if (canExtract) {
            setProgress(0, 1, "Looking for a live Linux kernel in the ISO…");
            $("#boot-description").textContent = "Reading casper/live kernel files from the ISO. This skips the CD boot menu.";
            log("Scanning the ISO for a live kernel (Ubuntu/Mint casper or Debian live)…");
            try {
                const extracted = await extractLiveLinux(state.source, entry?.live, {
                    signal: streamController?.signal,
                    onProgress: (loaded, total) => setProgress(loaded, total, "Reading live kernel and initrd…"),
                });
                bzimage = extracted.bzimage;
                initrd = extracted.initrd;
                cmdline = extracted.cmdline;
                log(`Direct kernel boot: ${extracted.kernelPath} (${fmtBytes(extracted.kernelSize)}) + ${extracted.initrdPath} (${fmtBytes(extracted.initrdSize)}).`, "ok");
            } catch (error) {
                log(`Direct kernel boot unavailable (${describeError(error)}). Falling back to CD-ROM boot.`, "warn");
            }
        }
        // Optional second disk: an empty ArrayBuffer the guest can install onto,
        // or an existing image read into RAM (so writes are possible).
        let hardDisk = null;
        if (state.disk.mode === "new") {
            const bytes = state.disk.sizeMB * 1024 * 1024;
            state.disk.buffer = new ArrayBuffer(bytes);
            hardDisk = { buffer: state.disk.buffer };
            log(`Created an empty ${state.disk.sizeMB} MB hard disk (hda).`);
        } else if (state.disk.mode === "file" && state.disk.file) {
            setProgress(0, 1, `Loading ${state.disk.file.name}…`);
            state.disk.buffer = await readFileToArrayBuffer(state.disk.file, (loaded, total) => {
                setProgress(loaded, total, `Loading ${state.disk.file.name}…`);
            });
            hardDisk = { buffer: state.disk.buffer };
            log(`Hard disk attached: ${state.disk.file.name} (${fmtBytes(state.disk.buffer.byteLength)}).`);
        }
        $("#disk-download").disabled = !hardDisk;

        setProgress(1, 1, "Starting emulator…");
        $("#image-strategy").textContent = strategy;

        await engine.boot({
            image, filesystem, cmdline, bzimage, initrd,
            wasmPath: want64 ? WASM_PATH_64 : WASM_PATH,
            device: state.source.device,
            memoryMB: machine.memoryMB,
            vgaMB: machine.vgaMB,
            bootOrder,
            nicType: machine.nicType,
            relayUrl,
            acpi: machine.acpi,
            sound: machine.sound,
            disableJit: machine.disableJit,
            instantBoot: machine.instantBoot,
            hardDisk,
            autostart: !restoreBuffer,
        });
        if (restoreBuffer) { await engine.restoreState(restoreBuffer); await engine.run(); }
        log(`Disk image: ${strategy}${bzimage ? " · live kernel extracted" : ""}.`);
        if (relayUrl) log(`Network backend: ${relayUrl}`);
        if (entry?.live || entry?.status === "tricky") showGuestBootHint(entry, Boolean(bzimage));
        if (!bzimage && entry?.live) scheduleBootMenuEnter();
    } catch (error) {
        if (engine.isAttached) await engine.destroy();
        state.active = null;
        showError(describeError(error));
        setStatus("error");
        setProgress(0, 0, "");
    } finally {
        state.busy = false;
        refreshControls();
        updateComputerDetails();
    }
}

async function powerOff() {
    if (!engine.isAttached || state.busy || state.sessionBusy) return;
    if (!confirm("Power off this computer? Unsaved guest work will be lost. Any explicitly saved browser session stays available.")) return;
    screenInput.release();
    await engine.destroy();
    state.active = null;
    state.disk.buffer = null;
    $("#disk-download").disabled = true;
    $("#type-box").hidden = true;
    refreshControls();
    updateComputerDetails();
    log("Virtual machine powered off. No automatic local save was made.", "ok");
}

async function saveState() {
    if (!engine.isAttached) {
        log("Start the machine before saving its state.", "warn");
        return;
    }
    if (state.sessionBusy || state.busy) return;
    state.sessionBusy = true;
    $("#tools-menu").open = false;
    screenInput.release();
    refreshControls();
    try {
        const state_ = await engine.saveState();
        downloadBlob(new Blob([state_], { type: "application/octet-stream" }), "v86-state.bin");
        log(`State downloaded (${fmtBytes(state_.byteLength)}). Load it later from the same machine settings.`, "ok");
    } catch (error) {
        log(`Saving state failed: ${describeError(error)}`, "error");
    } finally { state.sessionBusy = false; refreshControls(); }
}

async function loadState(file) {
    if (!engine.isAttached) {
        log("Boot the machine first, then load a state file into it.", "warn");
        return;
    }
    if (state.sessionBusy || state.busy) return;
    state.sessionBusy = true;
    screenInput.release();
    refreshControls();
    try {
        const buffer = await file.arrayBuffer();
        await engine.restoreState(buffer);
        // v86 restores disk internals; the old application-side ArrayBuffer is
        // no longer an authoritative export of a restored installation.
        state.disk.buffer = null;
        $("#disk-download").disabled = true;
    } catch (error) {
        log(`Restoring state failed: ${describeError(error)}`, "error");
    } finally { state.sessionBusy = false; refreshControls(); }
}

/* ------------------------------------------------------------------ *
 * Status, log, progress
 * ------------------------------------------------------------------ */

function setStatus(status) {
    const pill = $("#status-pill");
    const labels = { idle: "Ready", loading: "Starting…", ready: "Booting…", running: "Running", paused: "Paused", error: "Error", stopped: "Stopped" };
    pill.textContent = labels[status] || status;
    pill.className = `pill status-${status}`;
    document.body.dataset.vmstate = status;
    const loading = status === "loading" || status === "ready";
    $("#btn-start").hidden = loading || status === "running" || status === "paused";
    $("#screen-overlay").hidden = status === "running" || status === "paused";
    $("#welcome-card").hidden = loading;
    $("#boot-card").hidden = !loading;
    $("#paused-banner").hidden = status !== "paused";
    $("#input-tip").hidden = status !== "running" || Boolean(screenInput?.captured);
    updateComputerDetails();
}

function handleEngineState(status, detail) {
    state.lastState = status;
    setStatus(status === "stopped" ? "paused" : status);
    if (status !== "running") screenInput?.release();
    refreshControls();
    if (status === "running") {
        setProgress(1, 1, "");
        startMetricTicker();
    } else stopMetricTicker();
    if (status === "error" && detail?.message) showError(detail.message);
    if (status === "idle") {
        $("#image-strategy").textContent = "—";
        $("#mips").textContent = "— MIPS";
        $("#uptime").textContent = "—";
        $("#instructions").textContent = "—";
        hideGuestBootHint();
    }
    scheduleFit();
}

function refreshControls() {
    const busy = state.busy || state.sourceBusy || state.sessionBusy;
    const usable = engine.isAttached && ["running", "paused"].includes(engine.state) && !busy;
    ["#btn-pause", "#btn-reset", "#btn-power", "#btn-screenshot", "#btn-cad", "#btn-enter", "#btn-state-save", "#btn-state-load", "#btn-type", "#btn-paste"].forEach((selector) => { $(selector).disabled = !usable; });
    $("#btn-pause").textContent = engine.isRunning ? "Pause" : "Resume";
    $("#btn-grab-mouse").disabled = !engine.isRunning || busy;
    $("#btn-session-save").disabled = !usable || !sessionStore.supported || !canRememberSession(state.active);
    $("#btn-session-save").title = state.active?.source.kind === "filesystem" ? "This demand-loaded filesystem does not yet support browser-session saves; changes are temporary." : "Explicitly save this session in this browser";
    $$(".sidebar button, .sidebar input, .sidebar select").forEach((control) => { control.disabled = engine.isAttached || busy; });
    $$("[data-tab]").forEach((button) => { button.disabled = busy; });
    $("#disk-download").disabled = busy || !state.disk.buffer;
    $("#setup-lock-note").hidden = !engine.isAttached;
    $$("[data-quick-launch]").forEach((button) => { button.disabled = engine.isAttached || busy; });
    $("#quick-mint").disabled = engine.isAttached || busy;
    $("#quick-ubuntu").disabled = engine.isAttached || busy;
    const bootEnter = $("#guest-boot-enter");
    if (bootEnter) bootEnter.disabled = !engine.isRunning || busy;
    $("#quick-linux-internet").disabled = engine.isAttached || busy;
    $("#btn-session-resume").disabled = engine.isAttached || busy;
    $("#btn-session-delete").disabled = busy;
    $("#type-send").disabled = !engine.isRunning || busy;
    $("#type-close").disabled = busy;
    $("#type-input").disabled = busy;
    $("#btn-type").disabled = !engine.isRunning || busy;
    $("#btn-paste").disabled = !engine.isRunning || busy;
    updateStartHint();
}

function updateComputerDetails() {
    const entry = getEntry(state.active?.osId || state.selectedId);
    $("#computer-detail").textContent = entry ? `${entry.name} · ${entry.desktop} · ${state.active?.machine.memoryMB || state.machine.memoryMB} MB RAM` : "Ready when you are";
    const source = state.active?.source || state.source;
    $("#source-badge").textContent = source?.kind === "filesystem" ? "On-demand Linux files · no ISO" : source?.kind === "url" ? "Streamed image · no ISO to save" : source?.kind === "file" ? "Local image · never uploaded" : "Small built-in image";
}

function setProgress(loaded, total, label) {
    const percent = total > 0 ? clamp((loaded / total) * 100, 0, 100) : 0;
    const bar = $("#progress-bar");
    bar.style.width = total > 0 ? `${percent}%` : "0%";
    bar.classList.toggle("is-indeterminate", total <= 0);
    $("#progress-label").textContent = label || "";
    $("#progress-detail").textContent = total > 0 && loaded < total
        ? `${fmtBytes(loaded)} of ${fmtBytes(total)}`
        : "";
    $("#progress").hidden = !label;
}

function handleProgress(info) {
    const label = info.fileName ? `Loading ${fileNameFromUrl(info.fileName) || info.fileName}` : "Loading disk image";
    setProgress(info.loaded, info.total, `${label}…`);
    if (info.lengthComputable && info.total > 0 && info.loaded >= info.total) {
        setTimeout(() => { if (["loading", "ready"].includes(engine.state)) setProgress(1, 1, "Booting…"); }, 400);
    }
}

function log(message, level = "info") {
    const body = $("#log-body");
    if (!body) return;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = document.createElement("div");
    line.className = `log-line log-${level}`;
    line.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    while (body.childElementCount > 400) body.firstElementChild?.remove();
}

function showError(message) {
    const box = $("#error-box");
    box.hidden = false;
    $("#error-text").textContent = message;
    log(message, "error");
}

/* ------------------------------------------------------------------ *
 * Serial console + live-ISO boot hint
 * ------------------------------------------------------------------ */

let serialLine = "";
let serialLogged = 0;
let bootMenuTimer = 0;
const SERIAL_NOTEWORTHY = /panic|oops|error|fail|casper|squashfs|initramfs|lightdm|gdm|sddm|login:|reached target|gave up|alert|ubuntu|mint|busybox|kernel|nomodeset|unable to mount/i;

function handleSerialByte(byte) {
    if (byte === 13) return;
    if (byte === 10) {
        const line = serialLine.trim();
        serialLine = "";
        if (!line) return;
        const serialEl = $("#guest-boot-serial");
        if (serialEl) serialEl.textContent = line.slice(-160);
        const bootDesc = $("#boot-description");
        if (bootDesc && !$("#boot-card").hidden) bootDesc.textContent = line.slice(-180);
        if (SERIAL_NOTEWORTHY.test(line) || serialLogged % 20 === 0) {
            log(line.slice(0, 220), "serial");
        }
        serialLogged += 1;
        if (/lightdm|gdm|sddm|reached target graphical|started session|login:/i.test(line)) {
            hideGuestBootHint();
        }
        return;
    }
    if (byte >= 32 && byte < 127) {
        serialLine += String.fromCharCode(byte);
        if (serialLine.length > 240) serialLine = serialLine.slice(-120);
    }
}

function showGuestBootHint(entry, directKernel) {
    const hint = $("#guest-boot-hint");
    if (!hint) return;
    $("#guest-boot-title").textContent = `${entry?.name || "Linux"} is still starting`;
    $("#guest-boot-copy").textContent = directKernel
        ? "The live kernel is running. A desktop can take 5–40 minutes in this emulator. The CPU counter moving means it is working."
        : "Booting from the CD menu. Press Send Enter if you see a boot loader. Live desktops can take many minutes.";
    $("#guest-boot-serial").textContent = "";
    hint.hidden = false;
}

function hideGuestBootHint() {
    const hint = $("#guest-boot-hint");
    if (hint) hint.hidden = true;
    if (bootMenuTimer) {
        clearTimeout(bootMenuTimer);
        bootMenuTimer = 0;
    }
}

function scheduleBootMenuEnter() {
    if (bootMenuTimer) clearTimeout(bootMenuTimer);
    bootMenuTimer = window.setTimeout(() => {
        bootMenuTimer = 0;
        if (engine.isRunning) {
            sendGuestEnter().catch(() => {});
            log("Sent Enter to the guest boot menu (live ISO fallback).");
        }
    }, 8000);
}

async function sendGuestEnter() {
    try {
        await engine.sendEnter();
    } catch (error) {
        log(`Could not send Enter: ${describeError(error)}`, "warn");
    }
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

let metricTimer = 0;
let lastCounter = 0;
let lastSample = 0;

function startMetricTicker() {
    if (metricTimer) return;
    lastCounter = engine.instructionCounter();
    lastSample = performance.now();
    metricTimer = window.setInterval(() => {
        const counter = engine.instructionCounter();
        const now = performance.now();
        const seconds = (now - lastSample) / 1000;
        if (seconds > 0.4) {
            const mips = ((counter - lastCounter) >>> 0) / seconds / 1e6;
            $("#mips").textContent = `≈ ${mips.toFixed(0)} MIPS`;
            $("#instructions").textContent = `${fmtNumber(counter)} instructions`;
            $("#uptime").textContent = fmtDuration(engine.uptimeMs() / 1000);
            lastCounter = counter;
            lastSample = now;
        }
    }, 2000);
}

function stopMetricTicker() {
    if (metricTimer) {
        clearInterval(metricTimer);
        metricTimer = 0;
    }
}

/* ------------------------------------------------------------------ *
 * Footer / misc
 * ------------------------------------------------------------------ */

function updateFooterInfo() {
    $$("[data-repo-link]").forEach((element) => {
        element.setAttribute("href", element.dataset.repoPath ? `${REPO_URL}/blob/main/${element.dataset.repoPath}` : REPO_URL);
    });
    loadCoreVersion().then((text) => { $("#v86-version").textContent = `v86 ${text}`; }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Desktop mode, diskless launch, explicit session persistence
 * ------------------------------------------------------------------ */

function setDesktopMode(enabled, { persist = true } = {}) {
    state.ui.desktopMode = enabled;
    document.body.classList.toggle("desktop-mode", enabled);
    $("#btn-desktop").textContent = enabled ? "Show setup" : "Desktop mode";
    $("#btn-desktop").setAttribute("aria-pressed", String(enabled));
    if (persist) storeJson(UI_KEY, state.ui);
    scheduleFit();
}

function bindDesktopControls() {
    $("#btn-desktop").addEventListener("click", () => setDesktopMode(!state.ui.desktopMode));
    $("#quick-linux-internet").addEventListener("change", () => {
        state.machine.netBackend = $("#quick-linux-internet").checked ? "widgetry" : "none";
        applyMachineToForm();
        storeJson(SETTINGS_KEY, state.machine);
        log(state.machine.netBackend === "widgetry" ? "Public relay selected explicitly. This third-party service is not guaranteed; avoid private data." : "Guest internet disabled.");
    });
    $$("[data-quick-launch]").forEach((button) => button.addEventListener("click", () => {
        if (state.busy || state.sourceBusy || state.sessionBusy || engine.isAttached) return;
        selectOs(button.dataset.quickLaunch);
        state.disk = { mode: "none", sizeMB: 512, file: null, buffer: null };
        $("#disk-select").value = "none";
        $("#disk-select").dispatchEvent(new Event("change"));
        bootMachine({ desktop: true });
    }));
    window.addEventListener("beforeunload", (event) => {
        if (!engine.isAttached) return;
        event.preventDefault();
        event.returnValue = "";
    });
}

function bindDialogs() {
    $("#btn-storage-help").addEventListener("click", () => { screenInput.release(); $("#storage-dialog").showModal(); });
    $("#storage-close").addEventListener("click", () => $("#storage-dialog").close());
    $("#storage-explore-mint").addEventListener("click", () => { $("#storage-dialog").close(); openLegacyDialog("mint-19.3-xfce-32"); });
    $("#quick-mint").addEventListener("click", () => openLegacyDialog("mint-19.3-xfce-32"));
    $("#quick-ubuntu").addEventListener("click", () => openLegacyDialog("ubuntu-18.04.5-i386"));
    const closeLegacy = () => { streamController?.abort(); $("#legacy-dialog").close(); };
    $("#legacy-close").addEventListener("click", closeLegacy);
    $("#legacy-cancel").addEventListener("click", closeLegacy);
    $("#legacy-dialog").addEventListener("cancel", () => streamController?.abort());
    $("#legacy-ack").addEventListener("change", () => { $("#legacy-stream").disabled = !$("#legacy-ack").checked || state.sourceBusy; });
    $("#legacy-stream").addEventListener("click", () => {
        if ($("#legacy-ack").checked && state.legacyId) streamCatalogImage(state.legacyId);
    });
    $("#legacy-alt").addEventListener("click", () => openLegacyDialog("lubuntu-18.04.5-i386"));
    $("#guest-boot-dismiss").addEventListener("click", () => hideGuestBootHint());
    $("#guest-boot-enter").addEventListener("click", () => sendGuestEnter());
}

const LEGACY_COPY = {
    "ubuntu-18.04.5-i386": {
        eyebrow: "UBUNTU 18.04 · EXPERIMENTAL",
        mark: "ub",
        markClass: "os-mark ubuntu-mark",
        title: "Ubuntu, without saving an ISO.",
        warningTitle: "Legacy Ubuntu 18.04.5 Desktop · 32-bit",
        warningBody: "Ubuntu 18.04 is out of standard support. GNOME/Unity is heavy in this emulator — Lubuntu 18.04 (same base, LXDE) is the lighter path. Ubuntu 20.04+ cannot boot in v86.",
        alt: true,
    },
    "lubuntu-18.04.5-i386": {
        eyebrow: "LUBUNTU 18.04 · EXPERIMENTAL",
        mark: "lu",
        markClass: "os-mark ubuntu-mark",
        title: "Lubuntu, without saving an ISO.",
        warningTitle: "Legacy Lubuntu 18.04.5 · 32-bit LXDE",
        warningBody: "18.04 is out of standard support. Use it for experiments, not private accounts. This is the lightest Ubuntu-family desktop that still has a 32-bit live ISO.",
        alt: false,
    },
    "mint-19.3-xfce-32": {
        eyebrow: "LINUX MINT · EXPERIMENTAL",
        mark: "lm",
        markClass: "os-mark mint-mark",
        title: "Mint, without saving an ISO.",
        warningTitle: "Legacy Mint 19.3 Xfce · 32-bit",
        warningBody: "This release no longer receives security updates. Use it for experiments, not private accounts or everyday work. Mint 20+ cannot boot in v86.",
        alt: false,
    },
};

function openLegacyDialog(id) {
    if (engine.isAttached || state.busy || state.sessionBusy || state.sourceBusy) {
        log("Power off the current guest before choosing another image.", "warn");
        return;
    }
    const entry = getEntry(id);
    const copy = LEGACY_COPY[id];
    if (!entry || !copy) return;
    state.legacyId = id;
    $("#legacy-eyebrow").textContent = copy.eyebrow;
    $("#legacy-mark").textContent = copy.mark;
    $("#legacy-mark").className = copy.markClass;
    $("#legacy-title").textContent = copy.title;
    $("#legacy-warning-title").textContent = copy.warningTitle;
    $("#legacy-warning-body").textContent = copy.warningBody;
    $("#legacy-alt").hidden = !copy.alt;
    $("#legacy-ack").checked = false;
    $("#legacy-stream").disabled = true;
    $("#legacy-stream-status").textContent = "";
    $("#legacy-stream-status").classList.remove("is-error");
    $("#legacy-dialog").showModal();
}

function openMintDialog() {
    openLegacyDialog("mint-19.3-xfce-32");
}

async function streamCatalogImage(id) {
    if (state.busy || state.sourceBusy || state.sessionBusy || engine.isAttached) return;
    const entry = getEntry(id);
    const direct = entry?.links.filter((link) => link.kind === "direct").map((link) => link.url) || [];
    if (!direct.length) return;
    const inDialog = Boolean($("#legacy-dialog")?.open);
    const relayFirst = RELAY_IDS.includes(id);
    const candidates = relayFirst ? [`api/images/${id}.iso`, ...direct] : direct;
    const controller = new AbortController();
    streamController = controller;
    state.sourceBusy = true;
    refreshControls();
    $("#legacy-stream").disabled = true;
    $("#legacy-ack").disabled = true;
    $("#legacy-stream-status").classList.remove("is-error");
    let found = null;
    try {
        for (const [index, url] of candidates.entries()) {
            if (controller.signal.aborted) return;
            const label = url.startsWith("api/") ? "the server image relay" : `mirror ${relayFirst ? index : index + 1}`;
            if (inDialog) $("#legacy-stream-status").textContent = `Checking ${label}… You can cancel. No ISO file is being saved.`;
            log(`Checking ${entry.name}: ${label}.`);
            const probe = await probeUrl(url, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (probe.ok && canStream(probe)) { found = { url, ...probe }; break; }
            log(`Streaming unavailable from ${label}: ${probe.error || "Byte ranges or image size were not verified."}`, "warn");
        }
        if (!found) {
            const message = `No accessible streaming source was found for ${entry.name}. This host may be unable to reach the mirrors, or they may block CORS. ` +
                "No full ISO was downloaded. Configure the Node host’s image URL, supply a CORS + Range-enabled URL, or use the instant Alpine desktop. Current 64-bit Ubuntu/Mint need a separate remote VM.";
            if (inDialog) {
                $("#legacy-stream-status").textContent = message;
                $("#legacy-stream-status").classList.add("is-error");
            } else showError(message);
            return;
        }
        state.sourceBusy = false;
        selectOs(id);
        state.ui.streamOnly = true;
        storeJson(UI_KEY, state.ui);
        $("#stream-only").checked = true;
        state.source = {
            kind: "url", url: found.url, label: fileNameFromUrl(found.url),
            sizeBytes: found.size, acceptRanges: true, streamOnly: true, device: entry.device,
        };
        state.probe = found;
        $("#url-input").value = found.url;
        $("#url-result").innerHTML = `<p class="probe ok">Streaming verified. The ISO stays on its host.</p>`;
        setSourceTab("url");
        state.disk = { mode: "none", sizeMB: 512, file: null, buffer: null };
        $("#disk-select").value = "none";
        $("#disk-select").dispatchEvent(new Event("change"));
        renderDiskPanel();
        if (inDialog) $("#legacy-dialog").close();
        log(`Streaming ready: ${entry.name} (${fmtBytes(found.size)} ISO; not saved locally).`, "ok");
        await bootMachine({ desktop: true });
    } catch (error) {
        if (!controller.signal.aborted) {
            if (inDialog) { $("#legacy-stream-status").textContent = describeError(error); $("#legacy-stream-status").classList.add("is-error"); }
            else showError(describeError(error));
        }
    } finally {
        state.sourceBusy = false;
        streamController = null;
        $("#legacy-ack").disabled = false;
        $("#legacy-stream").disabled = !$("#legacy-ack").checked;
        refreshControls();
    }
}

function loadCoreVersion() {
    if (!versionPromise) {
        versionPromise = fetch("assets/v86/VERSION", { cache: "no-store" })
            .then(async (response) => {
                if (!response.ok) throw new Error("Could not verify the emulator version for a saved session.");
                const text = (await response.text()).trim();
                if (!/^\d+(?:\.\d+)+$/.test(text)) throw new Error("The emulator version file is invalid.");
                state.coreVersion = text;
                return text;
            }).catch((error) => { versionPromise = null; throw error; });
    }
    return versionPromise;
}

async function refreshSavedSession() {
    try { state.sessionSummary = sessionStore.supported ? await sessionStore.summary() : null; }
    catch (error) { state.sessionSummary = null; log(`Browser resume unavailable: ${describeError(error)}. You can still run without saving.`, "warn"); }
    const summary = state.sessionSummary;
    $("#saved-session").hidden = !summary;
    if (summary) {
        const entry = getEntry(summary.osId);
        $("#session-name").textContent = entry?.name || "Saved computer";
        $("#session-summary").textContent = `${fmtBytes(summary.bytes)} stored on this device · ${new Date(summary.createdAt).toLocaleString()}`;
    }
}

function sessionFeedback(message, error = false) {
    $("#session-feedback").hidden = false;
    $("#session-feedback").textContent = message;
    $("#session-feedback").classList.toggle("is-error", error);
    log(message, error ? "warn" : "ok");
}

function bindSessions() {
    $("#btn-session-save").addEventListener("click", saveBrowserSession);
    $("#btn-session-resume").addEventListener("click", resumeBrowserSession);
    $("#btn-session-delete").addEventListener("click", async () => {
        if (state.busy || state.sessionBusy || state.sourceBusy || !confirm("Delete the saved browser snapshot and free its local storage? This does not affect a running guest.")) return;
        state.sessionBusy = true;
        refreshControls();
        try { await sessionStore.clear(); await refreshSavedSession(); sessionFeedback("Saved browser session deleted. Its local storage was released."); }
        catch (error) { sessionFeedback(describeError(error), true); }
        finally { state.sessionBusy = false; refreshControls(); }
    });
}

async function saveBrowserSession() {
    if (state.busy || state.sessionBusy || state.sourceBusy || !engine.isAttached || !canRememberSession(state.active)) return;
    if (!confirm(`Save a snapshot on THIS device? It uses local storage, replaces the previous saved session, and must fit the ${fmtBytes(SESSION_LIMIT_BYTES)} limit. Saving a ${state.active.machine.memoryMB} MB guest may also need considerable RAM. This is optional, not cloud storage.`)) return;
    state.sessionBusy = true;
    $("#tools-menu").open = false;
    screenInput.release();
    refreshControls();
    try {
        const version = await loadCoreVersion();
        const buffer = await engine.saveState();
        const metadata = sessionMetadata(state.active, version, buffer.byteLength);
        await sessionStore.save(metadata, buffer);
        await refreshSavedSession();
        sessionFeedback(`Session saved here (${fmtBytes(buffer.byteLength)} of local storage). Resume it from the welcome screen; delete it there to free space. No autosave is enabled.`);
    } catch (error) { sessionFeedback(`Session was not saved: ${describeError(error)}`, true); }
    finally { state.sessionBusy = false; refreshControls(); }
}

async function resumeBrowserSession() {
    if (state.busy || state.sourceBusy || state.sessionBusy || engine.isAttached) return;
    state.sessionBusy = true;
    refreshControls();
    try {
        const { metadata, buffer } = await sessionStore.read();
        validateSession(metadata, await loadCoreVersion());
        if (metadata.source.kind === "url") {
            const probe = await probeUrl(metadata.source.url);
            if (!canStream(probe) || probe.size !== metadata.source.sizeBytes) {
                throw new Error("The saved image is unreachable or its size has changed. Restore requires the same streaming image.");
            }
        }
        selectOs(metadata.osId);
        state.machine = { ...defaults(), ...metadata.machine };
        state.source = { ...metadata.source };
        state.disk = { mode: "none", sizeMB: 512, file: null, buffer: null };
        $("#disk-select").value = "none";
        $("#disk-select").dispatchEvent(new Event("change"));
        applyMachineToForm();
        setSourceTab(metadata.source.kind === "url" ? "url" : "builtin");
        if (metadata.source.kind === "url") $("#url-input").value = metadata.source.url;
        renderSelection();
        renderDiskPanel();
        await bootMachine({ desktop: true, restoreBuffer: buffer });
        if (engine.isRunning) sessionFeedback("Saved session resumed. New work stays temporary until you explicitly save again.");
    } catch (error) { sessionFeedback(`Could not resume: ${describeError(error)}`, true); }
    finally { state.sessionBusy = false; refreshControls(); }
}

window.addEventListener("error", (event) => {
    if (event.error?.message?.includes("wasm")) {
        showError(`Emulator failed to start: ${event.error.message}`);
    }
});

init();
