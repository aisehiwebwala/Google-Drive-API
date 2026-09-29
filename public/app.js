const POLL_INTERVAL_MS = 5000;

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginForm = document.getElementById("login-form");
const keyInput = document.getElementById("key-input");
const loginError = document.getElementById("login-error");
const linkForm = document.getElementById("link-form");
const linkMessage = document.getElementById("link-message");
const runBtn = document.getElementById("run-btn");
const runMessage = document.getElementById("run-message");
const linksBody = document.getElementById("links-body");
const linksEmpty = document.getElementById("links-empty");
const pendingSummary = document.getElementById("pending-summary");
const sessionTimer = document.getElementById("session-timer");
const refreshNote = document.getElementById("refresh-note");

let pollTimer = null;
let countdownTimer = null;
let sessionExpiresAt = null;

/* ------------------------------------------------------------- helpers ---- */

const showMessage = (element, text, kind) => {
    element.textContent = text;
    element.className = `message ${kind}`;
    element.hidden = false;
};

const hideMessage = (element) => {
    element.hidden = true;
};

// Every API response is funnelled through here so a 401 anywhere - expired
// cookie, cleared cookie, tampered token - drops straight back to the login
// screen instead of failing silently.
const api = async (path, options = {}) => {
    const response = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...options,
    });

    let body = {};
    try {
        body = await response.json();
    } catch {
        // 204s and error pages have no JSON body.
    }

    if (response.status === 401) {
        // Always explain the bounce. A silent return to the login screen is
        // indistinguishable from the login having failed outright.
        const reasons = {
            expired: "Your session expired. Please sign in again.",
            missing: "You were signed out. Please sign in again.",
            invalid: "Your session was rejected. Please sign in again.",
        };
        showLogin(reasons[body.reason] || "Please sign in again.");
        throw new Error(body.error || "Unauthorized");
    }

    if (!response.ok) {
        throw new Error(body.error || `Request failed (${response.status})`);
    }

    return body;
};

// Headers textarea -> object. Accepts "Name: value" per line, ignores blanks.
const parseHeaderLines = (text) => {
    const headers = {};
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const separator = line.indexOf(":");
        if (separator < 1) {
            throw new Error(`Could not read header line: "${line}". Use "Name: value".`);
        }
        headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return headers;
};

const formatTimestamp = (value) => {
    const parsed = Date.parse(value);
    if (!parsed) return value || "-";
    return new Date(parsed).toLocaleString();
};

const statusKind = (link) => {
    if (link.completed) return "done";
    const status = (link.status || "").toLowerCase();
    if (status === "not started") return "idle";
    if (status.includes("start") || status.includes("upload") || status.includes("download")) return "active";
    return "failed";
};

/* -------------------------------------------------------------- screens ---- */

function showLogin(errorText) {
    stopPolling();
    sessionExpiresAt = null;
    appScreen.hidden = true;
    loginScreen.hidden = false;
    keyInput.value = "";

    if (errorText) {
        showMessage(loginError, errorText, "error");
    } else {
        hideMessage(loginError);
    }
    keyInput.focus();
}

function showApp(expiresAt) {
    sessionExpiresAt = expiresAt;
    loginScreen.hidden = true;
    appScreen.hidden = false;
    hideMessage(loginError);
    updateCountdown();
    refreshLinks();
    startPolling();
}

/* ------------------------------------------------------------- session ---- */

function updateCountdown() {
    if (!sessionExpiresAt) {
        sessionTimer.textContent = "";
        return;
    }
    const remaining = sessionExpiresAt - Date.now();
    if (remaining <= 0) {
        showLogin("Your session expired. Please sign in again.");
        return;
    }
    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    sessionTimer.textContent =
        hours > 0 ? `Session: ${hours}h ${minutes % 60}m left` : `Session: ${minutes}m left`;
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshLinks, POLL_INTERVAL_MS);
    countdownTimer = setInterval(updateCountdown, 30000);
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    pollTimer = null;
    countdownTimer = null;
}

/* --------------------------------------------------------------- render ---- */

function renderLinks(links) {
    linksBody.replaceChildren();
    linksEmpty.hidden = links.length > 0;

    for (const link of links) {
        const row = document.createElement("tr");
        const url = link.data?.url || "";
        const kind = statusKind(link);

        const statusCell = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `badge ${kind}`;
        badge.textContent = link.status || (link.completed ? "Completed" : "Unknown");
        statusCell.appendChild(badge);

        const urlCell = document.createElement("td");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noreferrer noopener";
        anchor.className = "url";
        anchor.textContent = url;
        anchor.title = url;
        urlCell.appendChild(anchor);

        const nameCell = document.createElement("td");
        nameCell.textContent = link.data?.filename || "-";

        const updatedCell = document.createElement("td");
        updatedCell.className = "muted nowrap";
        updatedCell.textContent = formatTimestamp(link.updatedAt);

        const actionCell = document.createElement("td");
        actionCell.className = "row-actions";
        if (kind === "failed" || kind === "done") {
            actionCell.appendChild(makeRowButton("Retry", () => retryLink(link.id)));
        }
        actionCell.appendChild(makeRowButton("Delete", () => deleteLink(link.id, url), true));

        row.append(statusCell, urlCell, nameCell, updatedCell, actionCell);
        linksBody.appendChild(row);
    }

    const pending = links.filter((link) => !link.completed).length;
    pendingSummary.textContent =
        pending === 0 ? "No pending links." : `${pending} link${pending === 1 ? "" : "s"} pending.`;
    runBtn.disabled = pending === 0;
    refreshNote.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function makeRowButton(label, handler, danger = false) {
    const button = document.createElement("button");
    button.className = danger ? "ghost danger small" : "ghost small";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
}

/* --------------------------------------------------------------- actions ---- */

async function refreshLinks() {
    try {
        const { links } = await api("/api/links");
        renderLinks(links);
    } catch (error) {
        refreshNote.textContent = error.message;
    }
}

async function retryLink(id) {
    try {
        await api(`/api/links/${id}/retry`, { method: "POST" });
        refreshLinks();
    } catch (error) {
        showMessage(runMessage, error.message, "error");
    }
}

async function deleteLink(id, url) {
    if (!confirm(`Delete this link from the queue?\n\n${url}`)) return;
    try {
        await api(`/api/links/${id}`, { method: "DELETE" });
        refreshLinks();
    } catch (error) {
        showMessage(runMessage, error.message, "error");
    }
}

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage(loginError);

    try {
        const { expiresAt } = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ key: keyInput.value }),
        });
        showApp(expiresAt);
    } catch (error) {
        showMessage(loginError, error.message, "error");
    }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } finally {
        showLogin();
    }
});

linkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideMessage(linkMessage);

    let customHeaders;
    try {
        customHeaders = parseHeaderLines(document.getElementById("headers-input").value);
    } catch (error) {
        showMessage(linkMessage, error.message, "error");
        return;
    }

    try {
        await api("/api/links", {
            method: "POST",
            body: JSON.stringify({
                url: document.getElementById("url-input").value,
                filename: document.getElementById("filename-input").value,
                customHeaders,
            }),
        });
        linkForm.reset();
        showMessage(linkMessage, "Queued. Click “Run pending links” to start a job.", "success");
        refreshLinks();
    } catch (error) {
        showMessage(linkMessage, error.message, "error");
    }
});

runBtn.addEventListener("click", async () => {
    hideMessage(runMessage);
    runBtn.disabled = true;
    runBtn.textContent = "Dispatching…";

    try {
        const { actionsUrl } = await api("/api/run", { method: "POST" });
        // showMessage sets textContent, which already clears any prior children.
        showMessage(runMessage, "Workflow dispatched. ", "success");
        if (actionsUrl) {
            const anchor = document.createElement("a");
            anchor.href = actionsUrl;
            anchor.target = "_blank";
            anchor.rel = "noreferrer noopener";
            anchor.textContent = "View run on GitHub";
            runMessage.appendChild(anchor);
        }
    } catch (error) {
        showMessage(runMessage, error.message, "error");
    } finally {
        // Re-enable here rather than relying on renderLinks, so a failed
        // refresh cannot leave the button permanently stuck.
        runBtn.textContent = "Run pending links";
        runBtn.disabled = false;
        refreshLinks();
    }
});

document.getElementById("refresh-btn").addEventListener("click", refreshLinks);

document.getElementById("clear-btn").addEventListener("click", async () => {
    if (!confirm("Delete all completed links from Firestore?")) return;
    try {
        const { deletedCount } = await api("/api/links/completed", { method: "POST" });
        showMessage(runMessage, `Removed ${deletedCount} completed link(s).`, "success");
        refreshLinks();
    } catch (error) {
        showMessage(runMessage, error.message, "error");
    }
});

// Pause polling while the tab is hidden, resume (and refresh at once) on return.
document.addEventListener("visibilitychange", () => {
    if (appScreen.hidden) return;
    if (document.hidden) {
        stopPolling();
    } else {
        refreshLinks();
        startPolling();
    }
});

// The server already decided which screen to show and stamped it into the page,
// so there is no auth round trip here. This only wires up the matching state.
// Sessions that expire while the page is open are handled by api()'s 401 branch.
const initialSession = window.__SESSION__ ?? { authed: false };
if (initialSession.authed) {
    showApp(initialSession.expiresAt);
} else {
    showLogin();
}
