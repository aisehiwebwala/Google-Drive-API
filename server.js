const dotenv = require("dotenv");
dotenv.config();

const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

// Validate before requiring ./firebase, because firebase/config.js reads these
// env vars at import time and throws an opaque TypeError when they are missing.
const REQUIRED_ENV = [
    "APP_KEY",
    "JWT_SECRET",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "URL_COLLECTION_NAME",
];

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
    console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
    console.error("Copy .env.example to .env and fill it in.");
    process.exit(1);
}

const firebase_utils = require("./firebase/utils");

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = "gd_session";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "2h";
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE || "job.yml";
const GITHUB_REF = process.env.GITHUB_REF || "main";

if (!process.env.GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn("[warn] GITHUB_TOKEN / GITHUB_REPO not set - the Run button will return an error.");
}

// Fail at boot rather than inside the login handler. A malformed value ("abc")
// throws there, and a non-positive one ("0", "-5m") is worse: login succeeds and
// sets a cookie that is already expired, so every later request 401s and you get
// a login loop with no way out.
try {
    const probe = jwt.sign({ sub: "probe" }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const lifetime = jwt.decode(probe).exp - Math.floor(Date.now() / 1000);
    if (lifetime <= 0) {
        console.error(`JWT_EXPIRES_IN="${JWT_EXPIRES_IN}" yields a ${lifetime}s session. Use a positive span like 2h.`);
        process.exit(1);
    }
} catch (error) {
    console.error(`JWT_EXPIRES_IN="${JWT_EXPIRES_IN}" is not a valid timespan: ${error.message}`);
    process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

/* ---------------------------------------------------------------- auth ---- */

// Constant-time compare so a wrong key cannot be recovered by timing the response.
const keyMatches = (candidate) => {
    const expected = Buffer.from(process.env.APP_KEY);
    const actual = Buffer.from(typeof candidate === "string" ? candidate : "");
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
};

// Small in-memory throttle. Resets on restart, which is fine for a single-operator tool.
const failedAttempts = new Map();
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

const isLockedOut = (ip) => {
    const record = failedAttempts.get(ip);
    if (!record) return false;
    if (Date.now() - record.last > LOCKOUT_MS) {
        failedAttempts.delete(ip);
        return false;
    }
    return record.count >= LOCKOUT_THRESHOLD;
};

// Returns the decoded session, or null. Used both by requireAuth and by the
// page route, which needs the answer without turning it into a 401.
const readSession = (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
};

const requireAuth = (req, res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
        return res.status(401).json({ error: "Not signed in", reason: "missing" });
    }
    try {
        req.session = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (error) {
        res.clearCookie(SESSION_COOKIE);
        const expired = error.name === "TokenExpiredError";
        res.status(401).json({
            error: expired ? "Session expired" : "Invalid session",
            reason: expired ? "expired" : "invalid",
        });
    }
};

app.post("/api/login", (req, res) => {
    const ip = req.ip;
    if (isLockedOut(ip)) {
        return res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
    }

    if (!keyMatches(req.body?.key)) {
        const record = failedAttempts.get(ip) ?? { count: 0, last: 0 };
        failedAttempts.set(ip, { count: record.count + 1, last: Date.now() });
        return res.status(401).json({ error: "Invalid key", reason: "invalid" });
    }

    failedAttempts.delete(ip);

    const token = jwt.sign({ sub: "operator" }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const { exp } = jwt.decode(token);

    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        expires: new Date(exp * 1000),
        path: "/",
    });
    res.json({ expiresAt: exp * 1000 });
});

app.post("/api/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => {
    res.json({ expiresAt: req.session.exp * 1000 });
});

/* --------------------------------------------------------------- links ---- */

const parseHttpUrl = (value) => {
    try {
        const parsed = new URL(String(value));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.href;
    } catch {
        return null;
    }
};

// Headers arrive as a flat object from the UI; reject anything that is not string -> string.
const parseHeaders = (value) => {
    if (value === undefined || value === null || value === "") return {};
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.some(([name, headerValue]) => !name.trim() || typeof headerValue !== "string")) return null;
    return Object.fromEntries(entries.map(([name, headerValue]) => [name.trim(), headerValue]));
};

app.get("/api/links", requireAuth, async (req, res) => {
    try {
        res.json({ links: await firebase_utils.listLinks() });
    } catch (error) {
        res.status(502).json({ error: `Could not read Firestore: ${error.message}` });
    }
});

app.post("/api/links", requireAuth, async (req, res) => {
    const url = parseHttpUrl(req.body?.url);
    if (!url) {
        return res.status(400).json({ error: "A valid http(s) URL is required." });
    }

    const filename = typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
    const customHeaders = parseHeaders(req.body?.customHeaders);
    if (customHeaders === null) {
        return res.status(400).json({ error: "Custom headers must be name/value text pairs." });
    }

    try {
        res.status(201).json({ link: await firebase_utils.addLink({ url, filename, customHeaders }) });
    } catch (error) {
        res.status(502).json({ error: `Could not queue link: ${error.message}` });
    }
});

app.post("/api/links/:id/retry", requireAuth, async (req, res) => {
    const result = await firebase_utils.updateLink(req.params.id, {
        completed: false,
        status: "Not Started",
    });
    if (!result.success) {
        return res.status(502).json({ error: result.error });
    }
    res.json({ ok: true });
});

app.delete("/api/links/:id", requireAuth, async (req, res) => {
    const result = await firebase_utils.deleteByID(req.params.id);
    if (!result.success) {
        return res.status(502).json({ error: result.error });
    }
    res.json({ ok: true });
});

app.post("/api/links/completed", requireAuth, async (req, res) => {
    const result = await firebase_utils.deleteAllCompleted();
    if (result.success === false) {
        return res.status(502).json({ error: result.error });
    }
    res.json({ deletedCount: result.deletedCount ?? 0 });
});

/* ------------------------------------------------------------ dispatch ---- */

app.post("/api/run", requireAuth, async (req, res) => {
    if (!process.env.GITHUB_TOKEN || !GITHUB_REPO) {
        return res.status(500).json({
            error: "Server is missing GITHUB_TOKEN or GITHUB_REPO, so the workflow cannot be dispatched.",
        });
    }

    const endpoint =
        `https://api.github.com/repos/${GITHUB_REPO}` +
        `/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "google-drive-api-console",
            },
            body: JSON.stringify({ ref: GITHUB_REF }),
        });

        // A successful dispatch is 204 No Content.
        if (response.status !== 204) {
            const body = await response.text();
            return res.status(502).json({
                error: `GitHub API returned ${response.status}: ${body.slice(0, 300) || "(empty body)"}`,
            });
        }

        res.json({
            ok: true,
            actionsUrl: `https://github.com/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}`,
        });
    } catch (error) {
        // Node's fetch collapses network/TLS problems into a bare "fetch failed",
        // so unwrap error.cause to say what actually went wrong. Behind a
        // TLS-intercepting proxy this surfaces as SELF_SIGNED_CERT_IN_CHAIN,
        // which means Node needs NODE_EXTRA_CA_CERTS (see README).
        const cause = error.cause?.code || error.cause?.message;
        res.status(502).json({
            error: `Could not reach the GitHub API: ${error.message}${cause ? ` (${cause})` : ""}`,
        });
    }
});

// Unknown /api paths must answer in JSON; otherwise they fall through to the
// static handler and the client gets Express's default HTML error page.
app.use("/api", (req, res) => {
    res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

/* ---------------------------------------------------------------- serve ---- */

// The page is rendered per request from the session cookie so the first paint
// already shows the right screen. `Vary: Cookie` + `no-store` keep a cache from
// handing the signed-in shell to a signed-out visitor, or the reverse.
const TEMPLATE_PATH = path.join(__dirname, "views", "index.html");

app.get("/", async (req, res, next) => {
    try {
        const session = readSession(req);
        const template = await fs.readFile(TEMPLATE_PATH, "utf8");

        const html = template
            .replace("{{LOGIN_HIDDEN}}", session ? " hidden" : "")
            .replace("{{APP_HIDDEN}}", session ? "" : " hidden")
            .replace(
                "{{SESSION}}",
                JSON.stringify(
                    session ? { authed: true, expiresAt: session.exp * 1000 } : { authed: false },
                ),
            );

        res.set({
            "Cache-Control": "no-store",
            Vary: "Cookie",
            "Content-Type": "text/html; charset=utf-8",
        });
        res.send(html);
    } catch (error) {
        next(error);
    }
});

// index:false so the raw template is never reachable, placeholders and all.
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.use((error, req, res, next) => {
    // body-parser rejections carry their own status (400 malformed, 413 too big);
    // returning 500 for those both misreports the cause and hides it from the UI.
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(error);

    const known = {
        "entity.parse.failed": "Malformed JSON body.",
        "entity.too.large": "Request body is too large.",
    };
    res.status(status).json({
        error: known[error.type] || (status >= 500 ? "Unexpected server error." : error.message),
    });
});

// A serverless platform requires this file and supplies its own listener, so a
// port is only bound when this file is the process entry point (`node
// server.js`). An Express app is itself an (req, res) handler, which is exactly
// what the Vercel Node runtime and serverless-http both expect.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Console listening on http://localhost:${PORT}`);
    });
}

module.exports = app;
