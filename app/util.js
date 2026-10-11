/**
 * Small dependency-free helpers shared by the app modules.
 */

/** @param {number} bytes */
export function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    const digits = value < 10 ? 1 : 0;
    return `${value.toFixed(digits)} ${units[i]}`;
}

/** @param {number} seconds */
export function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
}

export function fmtNumber(n) {
    return Number(n).toLocaleString("en-US");
}

/** Escape text for safe insertion into HTML. */
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shorten a long URL for display: keeps the file name, hides the middle. */
export function shortenUrl(url, max = 58) {
    if (url.length <= max) return url;
    const head = url.slice(0, Math.floor(max * 0.55));
    const tail = url.slice(-Math.floor(max * 0.35));
    return `${head}…${tail}`;
}

/** Human readable file name from a URL (query string stripped). */
export function fileNameFromUrl(url) {
    try {
        const base = typeof location !== "undefined" ? location.href : "http://localhost/";
        const parsed = new URL(url, base);
        const name = parsed.pathname.split("/").filter(Boolean).pop();
        return name ? decodeURIComponent(name) : parsed.hostname;
    } catch {
        return url;
    }
}

export function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function readStoredJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

export function storeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage disabled (private mode) — settings are simply not remembered */
    }
}

/** Trailing-edge throttle that always delivers the last call. */
export function throttle(fn, ms) {
    let last = 0;
    let timer = 0;
    let pending = null;
    return (...args) => {
        pending = args;
        const now = Date.now();
        const run = () => {
            last = Date.now();
            timer = 0;
            const call = pending;
            pending = null;
            fn(...call);
        };
        if (now - last >= ms) {
            if (timer) {
                clearTimeout(timer);
                timer = 0;
            }
            run();
        } else if (!timer) {
            timer = setTimeout(run, ms - (now - last));
        }
    };
}
