/**
 * xylvar.top server.
 *
 * One small Node app that serves the static site (index.html, images,
 * brand-assets, admin.html) and adds the real backend the static site
 * lacked:
 *   POST /api/contact    - audit enquiry / contact form, stored as a lead
 *   POST /api/newsletter - newsletter signup, stored as a subscriber
 *   GET  /api/newsletter/unsubscribe?id=..&t=.. - one-click unsubscribe
 *   GET  /api/admin/leads | subscribers | email-log - token-protected
 *   GET  /api/health      - storage mode + whether email is configured
 *
 * Storage: Postgres when DATABASE_URL is set (the Dokploy setup), with
 * tables created on boot. Without DATABASE_URL it falls back to a local
 * JSON file (server/data.json, gitignored) so the app can be tested
 * locally. The health endpoint reports which mode is live, so a missing
 * DATABASE_URL in production is visible instead of silent.
 *
 * Email: Resend when RESEND_API_KEY is set. Team mail goes to TEAM_EMAIL
 * (default info@xylvar.top), sent from EMAIL_FROM (default
 * xylvar <info@xylvar.top>). Without a key, leads and subscribers are
 * still stored and every email attempt is logged as "skipped", so no
 * submission is ever lost silently. Email failures are logged, never
 * shown to the visitor, because the submission itself is already safe.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const TEAM_EMAIL = process.env.TEAM_EMAIL || "info@xylvar.top";
const EMAIL_FROM = process.env.EMAIL_FROM || "xylvar <info@xylvar.top>";
const APP_URL = (process.env.APP_URL || "https://xylvar.top").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const DATA_FILE = path.join(__dirname, "data.json");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
const validUrl = (v) => {
  let s = String(v || "").trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.hostname.includes(".") ? s : null;
  } catch {
    return null;
  }
};
const unsubscribeSecret = () => {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (d.secret) return d.secret;
  } catch {}
  const s = crypto.randomBytes(32).toString("hex");
  try {
    const d = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : {};
    d.secret = s;
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  } catch {}
  return s;
};
const unsubscribeToken = (id) =>
  crypto.createHmac("sha256", unsubscribeSecret()).update(`unsubscribe:${id}`).digest("base64url");

// ---------- storage ----------
let pool = null;
let storageMode = "file";
async function initStorage() {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL, email TEXT NOT NULL, company TEXT,
        website TEXT, country TEXT, interest TEXT, message TEXT NOT NULL,
        consent BOOLEAN NOT NULL DEFAULT FALSE, source TEXT NOT NULL DEFAULT 'contact',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS subscribers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE, name TEXT,
        consent BOOLEAN NOT NULL DEFAULT FALSE,
        subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        unsubscribed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS email_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        to_address TEXT NOT NULL, subject TEXT NOT NULL, tag TEXT NOT NULL,
        status TEXT NOT NULL, provider_message_id TEXT, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );`);
    storageMode = "postgres";
  }
}
function fileData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { leads: [], subscribers: [], email_log: [] };
  }
}
function fileSave(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
async function insertLead(row) {
  if (pool) {
    const r = await pool.query(
      `INSERT INTO leads (name, email, company, website, country, interest, message, consent, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [row.name, row.email, row.company, row.website, row.country, row.interest, row.message, row.consent, row.source],
    );
    return r.rows[0].id;
  }
  const d = fileData();
  const rec = { id: crypto.randomUUID(), ...row, created_at: new Date().toISOString() };
  d.leads.push(rec);
  fileSave(d);
  return rec.id;
}
async function upsertSubscriber(email, name) {
  if (pool) {
    const r = await pool.query(
      `INSERT INTO subscribers (email, name, consent, unsubscribed_at)
       VALUES ($1,$2,TRUE,NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, consent = TRUE, unsubscribed_at = NULL
       RETURNING id`,
      [email, name || null],
    );
    return r.rows[0].id;
  }
  const d = fileData();
  const ex = d.subscribers.find((s) => s.email.toLowerCase() === email.toLowerCase());
  if (ex) {
    ex.name = name || ex.name;
    ex.consent = true;
    ex.unsubscribed_at = null;
    fileSave(d);
    return ex.id;
  }
  const rec = { id: crypto.randomUUID(), email, name: name || null, consent: true, subscribed_at: new Date().toISOString(), unsubscribed_at: null };
  d.subscribers.push(rec);
  fileSave(d);
  return rec.id;
}
async function doUnsubscribe(id, token) {
  if (!crypto.timingSafeEqual(Buffer.from(token || ""), Buffer.from(unsubscribeToken(id)))) return false;
  if (pool) {
    const r = await pool.query(`UPDATE subscribers SET unsubscribed_at = now(), consent = FALSE WHERE id = $1 RETURNING id`, [id]);
    return r.rowCount > 0;
  }
  const d = fileData();
  const s = d.subscribers.find((x) => x.id === id);
  if (!s) return false;
  s.unsubscribed_at = new Date().toISOString();
  s.consent = false;
  fileSave(d);
  return true;
}
async function logEmail(entry) {
  if (pool) {
    await pool.query(
      `INSERT INTO email_log (to_address, subject, tag, status, provider_message_id, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.to, entry.subject, entry.tag, entry.status, entry.providerMessageId || null, entry.error || null],
    );
    return;
  }
  const d = fileData();
  d.email_log.push({ id: crypto.randomUUID(), to_address: entry.to, subject: entry.subject, tag: entry.tag, status: entry.status, provider_message_id: entry.providerMessageId || null, error: entry.error || null, created_at: new Date().toISOString() });
  fileSave(d);
}
async function listTable(table, limit = 500) {
  if (pool) {
    const order = table === "subscribers" ? "subscribed_at DESC" : "created_at DESC";
    const r = await pool.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT $1`, [limit]);
    return r.rows;
  }
  const d = fileData();
  return [...(d[table] || [])].reverse().slice(0, limit);
}

// ---------- email (Resend) ----------
async function sendEmail({ to, subject, tag, html, text, replyTo }) {
  if (!RESEND_KEY) {
    await logEmail({ to, subject, tag, status: "skipped", error: "RESEND_API_KEY not set" });
    return { status: "skipped" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text, reply_to: replyTo || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `Resend HTTP ${res.status}`);
    await logEmail({ to, subject, tag, status: "sent", providerMessageId: body.id || null });
    return { status: "sent", id: body.id || null };
  } catch (err) {
    await logEmail({ to, subject, tag, status: "failed", error: String(err.message || err).slice(0, 500) });
    return { status: "failed" };
  }
}

// ---------- rate limit (in-memory, per IP) ----------
const hits = new Map();
function rateLimited(ip, key, max, windowMs) {
  const now = Date.now();
  const k = `${ip}:${key}`;
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now);
  hits.set(k, arr);
  return false;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: storageMode, email: RESEND_KEY ? "configured" : "not_configured", teamEmail: TEAM_EMAIL, time: new Date().toISOString() });
});

app.post("/api/contact", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip, "contact", 5, 600_000)) return res.status(429).json({ status: "error", message: "Too many enquiries from this address. Please wait a few minutes, or email info@xylvar.top directly." });
  const b = req.body || {};
  if (typeof b.company_website2 === "string" && b.company_website2.trim()) {
    // Honeypot: pretend success, store nothing.
    return res.json({ status: "success", message: "Thanks, your message has been sent. We will reply by email." });
  }
  const name = String(b.name || "").trim();
  const business = String(b.business || "").trim();
  const site = b.website ? validUrl(b.website) : null;
  const email = String(b.email || "").trim();
  const message = String(b.message || "").trim();
  if (!name || !business || !site || !emailOk(email) || !message || b.consent !== true) {
    return res.status(400).json({ status: "error", message: "Please check the required fields: name, business, a valid website, a valid email, a message, and consent." });
  }
  const lead = {
    name,
    email,
    company: business,
    website: site,
    country: String(b.country || "").trim() || null,
    interest: String(b.interest || "").trim() || null,
    message,
    consent: true,
    source: "contact",
  };
  let leadId;
  try {
    leadId = await insertLead(lead);
  } catch (err) {
    console.error("[contact] store failed", err.message);
    return res.status(500).json({ status: "error", message: "Your enquiry could not be saved. Please email info@xylvar.top directly." });
  }
  const fields = [
    ["Name", name], ["Email", email], ["Business", business], ["Website", site],
    ["Country", lead.country || "Not given"], ["Interested in", lead.interest || "Not given"], ["Message", message],
  ];
  const rows = fields.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;vertical-align:top">${esc(v)}</td></tr>`).join("");
  const text = fields.map(([k, v]) => `${k}: ${v}`).join("\n");
  const team = await sendEmail({
    to: TEAM_EMAIL, subject: `New lead: audit enquiry - ${business}`, tag: "lead-team",
    html: `<h1>New lead: audit enquiry</h1><table>${rows}</table><p>Reply to this email to answer the lead directly.</p>`,
    text, replyTo: email,
  });
  const visitor = await sendEmail({
    to: email, subject: "Thanks - we've got your message", tag: "lead-autoreply",
    html: `<p>Hi ${esc(name)},</p><p>Thanks for getting in touch. We've received your message and a member of the team will reply within one working day.</p><p>If it's urgent, reply to this email and it will reach us directly.</p>`,
    text: `Hi ${name},\n\nThanks for getting in touch. We've received your message and a member of the team will reply within one working day.\n\nIf it's urgent, reply to this email and it will reach us directly.`,
  });
  res.json({ status: "success", message: "Thanks - your message is with us. We'll reply within one working day.", leadId, email: { team: team.status, visitor: visitor.status } });
});

app.post("/api/newsletter", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip, "newsletter", 5, 600_000)) return res.status(429).json({ status: "error", message: "Too many signups from this address. Please wait a few minutes." });
  const b = req.body || {};
  if (typeof b.company_website2 === "string" && b.company_website2.trim()) {
    return res.json({ status: "success", message: "You're subscribed. Check your inbox for a welcome email." });
  }
  const email = String(b.email || "").trim();
  const name = String(b.name || "").trim();
  if (!emailOk(email) || b.consent !== true) {
    return res.status(400).json({ status: "error", message: "Please enter a valid email and tick the consent box." });
  }
  let id;
  try {
    id = await upsertSubscriber(email, name);
  } catch (err) {
    console.error("[newsletter] store failed", err.message);
    return res.status(500).json({ status: "error", message: "Your signup could not be saved. Please email info@xylvar.top to subscribe." });
  }
  const unsub = `${APP_URL}/api/newsletter/unsubscribe?id=${id}&t=${encodeURIComponent(unsubscribeToken(id))}`;
  const welcome = await sendEmail({
    to: email, subject: "You're subscribed to the xylvar newsletter", tag: "newsletter-welcome",
    html: `<p>Hi${name ? ` ${esc(name)}` : ""},</p><p>You're subscribed to the xylvar newsletter. You'll hear from us when there is something worth sending, not on a fixed spam schedule.</p><p><a href="${esc(unsub)}">Unsubscribe</a></p>`,
    text: `Hi${name ? ` ${name}` : ""},\n\nYou're subscribed to the xylvar newsletter.\n\nUnsubscribe: ${unsub}`,
  });
  res.json({ status: "success", message: "You're subscribed. Check your inbox for a welcome email.", email: welcome.status });
});

app.get("/api/newsletter/unsubscribe", async (req, res) => {
  const ok = await doUnsubscribe(String(req.query.id || ""), String(req.query.t || "")).catch(() => false);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ok
    ? "<h1>Unsubscribed</h1><p>You have been removed from the xylvar newsletter.</p>"
    : "<h1>Link not valid</h1><p>This unsubscribe link is not valid. Email <a href=\"mailto:info@xylvar.top?subject=Unsubscribe\">info@xylvar.top</a> and we will remove you by hand.</p>");
});

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ status: "error", message: "Admin view is disabled: ADMIN_TOKEN is not set." });
  if (req.header("x-admin-token") !== ADMIN_TOKEN) return res.status(401).json({ status: "error", message: "Admin token required." });
  next();
}
app.get("/api/admin/leads", requireAdmin, async (_req, res) => res.json(await listTable("leads")));
app.get("/api/admin/subscribers", requireAdmin, async (_req, res) => res.json(await listTable("subscribers")));
app.get("/api/admin/email-log", requireAdmin, async (_req, res) => res.json(await listTable("email_log")));

// ---------- static site (allowlist only) ----------
const ALLOWED = new Set(["index.html", "xylvar-website.html", "favicon.ico", "apple-touch-icon.png", "admin.html", ".nojekyll"]);
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "admin.html")));
app.use((req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^\/+/, "");
  const first = rel.split("/")[0];
  if (ALLOWED.has(rel) || first === "images" || first === "brand-assets") {
    return express.static(ROOT, { index: false })(req, res, next);
  }
  return res.status(404).send("Not found");
});

initStorage()
  .then(() => app.listen(PORT, () => console.log(`xylvar server listening on ${PORT}, storage=${storageMode}, email=${RESEND_KEY ? "configured" : "not_configured"}`)))
  .catch((err) => {
    console.error("Storage init failed:", err);
    process.exit(1);
  });
