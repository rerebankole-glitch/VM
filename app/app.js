/**
 * The application layer: everything the user sees and clicks.
 *
 * Flow: pick an operating system → point at a disk image (built-in, local
 * file, or URL) → adjust the virtual hardware → start. The engine module does
 * the emulation, this module never touches v86 directly except through it.
 */

import { CATALOG, UNSUPPORTED, getEntry } from "./catalog.js";
import {
    BOOT_ORDERS, NET_BACKENDS, NIC_TYPES, VmEngine, describeError,
} from "./engine.js";
import {
    RAM_LIMIT_BYTES, bundledSource, describeSource, probeUrl, readFileToArrayBuffer, resolveImage,
} from "./sources.js";
import {
    clamp, downloadBlob, escapeHtml, fmtBytes, fmtDuration, fmtNumber, fileNameFromUrl,
    readStoredJson, shortenUrl, storeJson,
} from "./util.js";

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
    selectedId: "tiny-linux",
    /** Which sidebar step is showing: "os" | "disk" | "machine". */
    tab: "os",
    /** @type {import("./sources.js").DiskSource|null} */
    source: null,
    sourceTab: "builtin",
    machine: { ...defaults(), ...readStoredJson(SETTINGS_KEY, {}) },
    fit: true,
    zoom: 1,
    busy: false,
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
    },
});

persistableDefaultsFix();

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function init() {
    buildOsList();
    buildBlockedList();
    buildDiskPanel();
    buildMachinePanel();
    bindStepTabs();
    bindScreenInteractions();
    bindToolbar();
    bindKeyboardShortcuts();

    const remembered = localStorage.getItem("browser-vm.last-os");
    selectOs(getEntry(remembered) ? remembered : state.selectedId, { silent: true });
    applyMachineToForm();
    setSourceTab(state.sourceTab);
    setStatus("idle");
    log("Ready. Pick an operating system, then press Start.", "ok");
    log(`Emulator: v86 (BSD-2-Clause). Guest images stay on your machine — nothing is uploaded.`);
    updateFooterInfo();
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
            entry.status === "tricky" ? `<span class="badge slow">slow but real</span>` : "",
        ].filter(Boolean).join("");
        const size = entry.bundled ? fmtBytes(entry.sizeBytes) : `≈ ${fmtBytes(entry.sizeBytes)} ISO`;
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
    if (!entry) return;

    state.selectedId = id;
    localStorage.setItem("browser-vm.last-os", id);

    $$(".os-card").forEach((card) => {
        card.classList.toggle("is-selected", card.dataset.os === id);
    });

    // Recommend the machine settings for this guest, unless the user already
    // tuned them for this OS.
    if (!silent || !state.machine.tunedFor || state.machine.tunedFor !== id) {
        state.machine.memoryMB = entry.ramMB ?? state.machine.memoryMB;
        state.machine.vgaMB = entry.vgaMB ?? state.machine.vgaMB;
        state.machine.nicType = entry.status === "instant" && entry.family === "DOS" ? "ne2k" : state.machine.nicType;
        state.machine.tunedFor = id;
        applyMachineToForm();
    }

    if (entry.bundled) {
        state.source = bundledSource(entry);
        setSourceTab("builtin");
        state.sourceTab = "builtin";
    } else if (state.source?.bundledPath) {
        // A built-in image no longer matches the chosen OS.
        state.source = null;
        setSourceTab("file");
        state.sourceTab = "file";
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
            <p class="hint">Get the ISO (opens in a new tab; then open it with “From disk”):</p>
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
            <p class="os-download-title"><strong>${escapeHtml(entry.name)}</strong> ships with this page — nothing to download.</p>
            <p class="hint">Its image is already selected in step 2. Press <strong>Boot</strong> whenever you like.</p>`;
    } else if (entry.links?.length) {
        box.className = "os-download is-download";
        box.innerHTML = `
            <p class="os-download-title">Download the ISO for <strong>${escapeHtml(entry.name)} ${escapeHtml(entry.version)}</strong></p>
            ${linkRowHtml(entry)}
            <p class="hint">
                Save the file anywhere on this computer, then attach it in step 2
                (<em>From disk</em>). Your browser reads it locally — nothing is uploaded.
            </p>`;
    } else {
        box.className = "os-download";
        box.innerHTML = `
            <p class="os-download-title">No download link recorded for <strong>${escapeHtml(entry.name)}</strong> yet.</p>
            <p class="hint">See “Which distros work” in the footer for where to get a 32-bit image.</p>`;
    }
    box.hidden = false;
}

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

    // URL source
    $("#url-use").addEventListener("click", () => useRemoteUrl());
    $("#url-check").addEventListener("click", () => checkUrl());
    $("#url-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            checkUrl().then(() => {
                if (state.source?.kind === "url") setSourceTab("file", { keepSource: true });
            });
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
    const input = /** @type {HTMLInputElement} */ ($("#url-input"));
    const url = input.value.trim();
    const result = $("#url-result");
    if (!url) {
        result.innerHTML = `<p class="probe bad">Paste the direct link to an .iso first.</p>`;
        return null;
    }

    result.innerHTML = `<p class="probe">Checking ${escapeHtml(shortenUrl(url))} …</p>`;
    const probe = await probeUrl(url);

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

    result.innerHTML = `<p class="probe ok">Reachable.</p><ul class="probe-list">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>`;
    state.probe = { url, ...probe };
    return probe;
}

async function useRemoteUrl() {
    const probe = state.probe?.url === /** @type {HTMLInputElement} */ ($("#url-input")).value.trim()
        ? state.probe
        : await checkUrl();
    if (!probe?.ok) return;

    state.source = {
        kind: "url",
        url: probe.url,
        label: fileNameFromUrl(probe.url),
        sizeBytes: probe.size || 0,
        acceptRanges: probe.acceptRanges,
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

    $("#net-select").addEventListener("change", updateRelayVisibility);
    $("#reset-machine").addEventListener("click", () => {
        const entry = getEntry(state.selectedId);
        state.machine = {
            ...defaults(),
            memoryMB: entry?.ramMB ?? 128,
            vgaMB: entry?.vgaMB ?? 8,
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
    // Settings saved by an older version may miss newer keys.
    const merged = { ...defaults(), ...readStoredJson(SETTINGS_KEY, {}) };
    state.machine = merged;
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

    // Keyboard events are global in v86, so only enable them while the pointer
    // is over the screen; that keeps the page's own inputs usable.
    viewport.addEventListener("pointerenter", () => {
        if (!engine.isAttached) return;
        engine.setKeyboardEnabled(true);
        engine.setMouseEnabled(true);
        viewport.classList.add("is-capturing");
    });
    viewport.addEventListener("pointerleave", () => {
        engine.setKeyboardEnabled(false);
        engine.setMouseEnabled(false);
        engine.releaseModifiers();
        viewport.classList.remove("is-capturing");
    });
    viewport.addEventListener("click", () => {
        // A click locks the pointer so relative mice (X11 console, DOS games) work.
        if (engine.isAttached && engine.isRunning) engine.lockMouse();
    });

    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => scheduleFit()).observe(viewport);
    }
    window.addEventListener("resize", () => scheduleFit());
    document.addEventListener("fullscreenchange", () => scheduleFit());
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
    $("#btn-reset").addEventListener("click", () => engine.reset());
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
        });
    });
    $("#btn-cad").addEventListener("click", () => engine.sendCtrlAltDel());
    $("#btn-state-save").addEventListener("click", () => saveState());
    $("#btn-state-load").addEventListener("click", () => $("#state-input").click());
    $("#state-input").addEventListener("change", (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const file = input.files?.[0];
        if (file) loadState(file);
        input.value = "";
    });
    $("#btn-type").addEventListener("click", () => {
        const box = $("#type-box");
        box.hidden = !box.hidden;
        if (!box.hidden) /** @type {HTMLInputElement} */ ($("#type-input")).focus();
    });
    $("#type-send").addEventListener("click", () => {
        const input = /** @type {HTMLInputElement} */ ($("#type-input"));
        engine.sendText(input.value);
        input.value = "";
    });
    $("#type-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            $("#type-send").click();
        }
    });
    $("#btn-clear-log").addEventListener("click", () => { $("#log-body").innerHTML = ""; });
}

function bindKeyboardShortcuts() {
    document.addEventListener("keydown", (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const typing = target && (target.nodeName === "INPUT" || target.nodeName === "TEXTAREA" || target.nodeName === "SELECT");
        if (typing) return;
        if (event.key === "F11" && engine.v86) return; // let the browser handle it
        if (event.ctrlKey && event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            engine.sendCtrlAltDel();
        }
    });
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
    const viewport = $("#screen-viewport");
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await viewport.requestFullscreen();
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
    const ready = Boolean(state.source) && !state.busy;
    button.disabled = !ready;
    $("#start-hint").textContent = !state.source
        ? "Step 2: choose a disk image"
        : state.busy
            ? "Working…"
            : `Boot ${entry ? `${entry.name} ${entry.version}` : "the virtual machine"}`;

    // Point at step 2 while there is still nothing to boot from.
    const diskTab = /** @type {HTMLElement|null} */ (document.querySelector('[data-tab="disk"]'));
    diskTab?.classList.toggle("is-todo", !state.source);
}

function relayUrlFor(backendId, customUrl) {
    if (backendId === "none") return null;
    if (backendId === "custom") return (customUrl || "").trim() || null;
    return NET_BACKENDS.find((net) => net.id === backendId)?.relayUrl || null;
}

async function bootMachine() {
    if (state.busy) return;
    const entry = getEntry(state.selectedId);
    if (!state.source) {
        showError("Choose a disk image first.");
        return;
    }

    state.busy = true;
    state.bootStartedAt = performance.now();
    updateStartHint();
    setProgress(0, 1, "Preparing…");

    const machine = state.machine;
    let bootOrder = BOOT_ORDERS.find((order) => order.id === machine.bootOrder)?.value ?? 0;
    if (bootOrder === 0 && state.disk.mode !== "none") {
        // With a disk attached, prefer the removable media so "boot the ISO,
        // then install to hda" works without touching the boot order.
        bootOrder = state.source.device === "fda" ? 0x231 : 0x213;
    }
    const relayUrl = relayUrlFor(machine.netBackend, machine.customRelayUrl);

    try {
        log(`Booting ${entry ? `${entry.name} ${entry.version}` : "image"} as ${state.source.device}…`);
        const { image, strategy } = await resolveImage(state.source, {
            mode: machine.diskMode,
            onProgress: (loaded, total, label) => {
                setProgress(loaded, total, `Loading ${label || "disk image"}…`);
            },
        });
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
            image,
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
            autostart: true,
        });
        log(`Disk image: ${strategy}.`);
        if (relayUrl) log(`Network backend: ${relayUrl}`);
    } catch (error) {
        showError(describeError(error));
        setStatus("error");
    } finally {
        state.busy = false;
        updateStartHint();
    }
}

async function powerOff() {
    if (!engine.isAttached) return;
    await engine.destroy();
    log("Virtual machine powered off.", "ok");
}

async function saveState() {
    if (!engine.isAttached) {
        log("Start the machine before saving its state.", "warn");
        return;
    }
    try {
        const state_ = await engine.saveState();
        downloadBlob(new Blob([state_], { type: "application/octet-stream" }), "v86-state.bin");
        log(`State downloaded (${fmtBytes(state_.byteLength)}). Load it later from the same machine settings.`, "ok");
    } catch (error) {
        log(`Saving state failed: ${describeError(error)}`, "error");
    }
}

async function loadState(file) {
    if (!engine.isAttached) {
        log("Boot the machine first, then load a state file into it.", "warn");
        return;
    }
    try {
        const buffer = await file.arrayBuffer();
        await engine.restoreState(buffer);
    } catch (error) {
        log(`Restoring state failed: ${describeError(error)}`, "error");
    }
}

/* ------------------------------------------------------------------ *
 * Status, log, progress
 * ------------------------------------------------------------------ */

function setStatus(status) {
    const pill = $("#status-pill");
    const labels = {
        idle: "Idle", loading: "Loading…", ready: "Booting…", running: "Running",
        paused: "Paused", error: "Error", stopped: "Stopped",
    };
    pill.textContent = labels[status] || status;
    pill.className = `pill status-${status}`;
    document.body.dataset.vmstate = status;

    const startButton = /** @type {HTMLButtonElement} */ ($("#btn-start"));
    startButton.hidden = status === "running" || status === "paused";

    const overlay = $("#screen-overlay");
    overlay.hidden = status === "running" || status === "paused";
    if (status === "paused") $("#paused-banner").hidden = false;
    else $("#paused-banner").hidden = true;
}

function handleEngineState(status, detail) {
    state.lastState = status;
    setStatus(status === "stopped" ? "paused" : status);
    const running = status === "running" || status === "ready" || status === "loading";

    $("#btn-pause").disabled = !engine.isAttached;
    $("#btn-pause").textContent = engine.isRunning ? "Pause" : "Resume";
    $("#btn-reset").disabled = !engine.isAttached;
    $("#btn-power").disabled = !engine.isAttached;
    ["#btn-screenshot", "#btn-cad", "#btn-state-save", "#btn-type"].forEach((selector) => {
        /** @type {HTMLButtonElement} */ ($(selector)).disabled = !engine.isAttached;
    });

    if (status === "running") {
        setProgress(1, 1, "Running");
        $("#screen-overlay").hidden = true;
        startMetricTicker();
    } else {
        stopMetricTicker();
    }
    if (status === "error") {
        setProgress(0, 0, "Error");
        if (detail?.message) showError(detail.message);
    }
    if (status === "idle") {
        $("#image-strategy").textContent = "—";
        $("#screen-overlay").hidden = false;
    }
    if (running) scheduleFit();
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
        setTimeout(() => setProgress(1, 1, "Booting…"), 400);
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
            const mips = (counter - lastCounter) / seconds / 1e6;
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
    const version = $("#v86-version");
    fetch("assets/v86/VERSION")
        .then((response) => (response.ok ? response.text() : ""))
        .then((text) => {
            if (text.trim()) version.textContent = `v86 ${text.trim()}`;
        })
        .catch(() => {});
}

window.addEventListener("error", (event) => {
    if (event.error?.message?.includes("wasm")) {
        showError(`Emulator failed to start: ${event.error.message}`);
    }
});

init();
