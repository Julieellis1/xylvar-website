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
 *   GET  /audit           - dedicated audit download page (noindex)
 *   GET  /api/audit       - lookup one audit by its download code (noindex)
 *   GET  /api/audit/download - stream one audit PDF by code (noindex)
 *   POST /api/admin/audits, GET /api/admin/audits - seed and list audits, token-protected
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
      );
      CREATE TABLE IF NOT EXISTS audit_downloads (
        code TEXT PRIMARY KEY,
        business TEXT NOT NULL, website TEXT NOT NULL, report_date TEXT NOT NULL,
        pdf_file TEXT NOT NULL, title TEXT NOT NULL, pages INT NOT NULL,
        findings JSONB NOT NULL DEFAULT '[]'::jsonb,
        download_count INT NOT NULL DEFAULT 0,
        last_downloaded_at TIMESTAMPTZ,
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

// ---------- audit downloads ----------
// A download code is a lookup key for a complimentary report, not identity
// verification, and it is not secure access. Anyone who has the email has
// the code, so it only selects which audit to show, it never proves who
// the visitor is. PDF files live under server/audits/ and are read from
// disk by the server only. They are never added to the static allowlist,
// so a direct request to a file path returns 404.
const AUDIT_DIR = path.join(__dirname, "audits");
const AUDIT_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const auditCodeOk = (v) => /^[A-HJ-NP-Z2-9]{8}$/.test(String(v || "").trim().toUpperCase());
function generateAuditCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += AUDIT_CODE_CHARS[crypto.randomInt(AUDIT_CODE_CHARS.length)];
  return code;
}
function auditHost(website) {
  let s = String(website || "").trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function auditPublic(a) {
  if (!a) return null;
  return {
    business: a.business, website: a.website, report_date: a.report_date,
    title: a.title, pages: a.pages, findings: a.findings,
  };
}
async function getAudit(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!auditCodeOk(c)) return null;
  if (pool) {
    const r = await pool.query(`SELECT * FROM audit_downloads WHERE code = $1`, [c]);
    return r.rows[0] || null;
  }
  const d = fileData();
  return (d.audit_downloads || []).find((a) => a.code === c) || null;
}
async function insertAudit(a) {
  if (pool) {
    await pool.query(
      `INSERT INTO audit_downloads (code, business, website, report_date, pdf_file, title, pages, findings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.code, a.business, a.website, a.report_date, a.pdf_file, a.title, a.pages, JSON.stringify(a.findings)],
    );
    return;
  }
  const d = fileData();
  d.audit_downloads = d.audit_downloads || [];
  d.audit_downloads.push({ ...a, download_count: 0, last_downloaded_at: null, created_at: new Date().toISOString() });
  fileSave(d);
}
async function recordAuditDownload(code) {
  const c = String(code || "").trim().toUpperCase();
  if (pool) {
    await pool.query(`UPDATE audit_downloads SET download_count = download_count + 1, last_downloaded_at = now() WHERE code = $1`, [c]);
    return;
  }
  const d = fileData();
  const a = (d.audit_downloads || []).find((x) => x.code === c);
  if (a) {
    a.download_count = (a.download_count || 0) + 1;
    a.last_downloaded_at = new Date().toISOString();
    fileSave(d);
  }
}
async function listAuditsAdmin() {
  if (pool) {
    const r = await pool.query(`SELECT code, business, website, report_date, download_count, last_downloaded_at FROM audit_downloads ORDER BY created_at DESC`);
    return r.rows;
  }
  const d = fileData();
  return [...(d.audit_downloads || [])].reverse().map((a) => ({
    code: a.code, business: a.business, website: a.website, report_date: a.report_date,
    download_count: a.download_count || 0, last_downloaded_at: a.last_downloaded_at || null,
  }));
}
function validateAuditBody(b) {
  const code = String(b.code || "").trim().toUpperCase();
  if (!auditCodeOk(code)) return { error: "Code must be 8 characters, uppercase letters and digits, excluding O, I, 0 and 1." };
  const business = String(b.business || "").trim();
  if (!business || business.length > 200) return { error: "Business is required." };
  const website = b.website ? validUrl(b.website) : null;
  if (!website) return { error: "A valid website is required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.report_date || ""))) return { error: "Report date must use YYYY-MM-DD." };
  const pdf_file = String(b.pdf_file || "").trim();
  if (!pdf_file || path.basename(pdf_file) !== pdf_file || !pdf_file.toLowerCase().endsWith(".pdf")) {
    return { error: "pdf_file must be a plain PDF filename in server/audits/." };
  }
  if (!fs.existsSync(path.join(AUDIT_DIR, pdf_file))) return { error: "pdf_file is not present in server/audits/." };
  const title = String(b.title || "").trim();
  if (!title || title.length > 300) return { error: "Title is required." };
  const pages = Number(b.pages);
  if (!Number.isInteger(pages) || pages < 1) return { error: "Pages must be a positive whole number." };
  const findings = Array.isArray(b.findings) ? b.findings.map((f) => String(f || "").trim()).filter(Boolean) : [];
  if (findings.length < 1 || findings.length > 10) return { error: "Findings must be a list of 1 to 10 non-empty strings." };
  return { value: { code, business, website, report_date: String(b.report_date), pdf_file, title, pages, findings } };
}
function auditPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Your audit download | xylvar</title>
<style>
body{font-family:Arial,sans-serif;background:#faf6ec;color:#141310;max-width:640px;margin:0 auto;padding:32px 20px;line-height:1.6}
h1{font-size:26px} .card{background:#fff;border:1px solid #e4ddc9;border-radius:14px;padding:20px;margin:16px 0}
label{display:block;margin:12px 0 4px;font-weight:bold} input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px}
button,.btn{display:inline-block;background:#c8f31d;color:#141310;font-weight:bold;border:0;border-radius:999px;padding:12px 26px;font-size:16px;cursor:pointer;text-decoration:none}
.err{color:#a02622} .muted{color:#6b6e62;font-size:14px}
</style>
</head>
<body>
<h1>Your audit is ready</h1>
<p id="intro">Enter your website and code to download your report, or follow the link from your email.</p>
<div id="error" class="err"></div>
<form id="lookup" class="card">
<label for="website">Website</label>
<input id="website" name="website" type="text" placeholder="example.com" autocomplete="off">
<label for="code">Download code</label>
<input id="code" name="code" type="text" placeholder="8 character code" autocomplete="off">
<p><button type="submit">Find my audit</button></p>
</form>
<div id="result" class="card" hidden>
<h2 id="r-business"></h2>
<p><span id="r-title"></span><br><span id="r-meta"></span></p>
<ul id="r-findings"></ul>
<p><a id="r-download" class="btn" href="#">Download PDF</a></p>
<div id="next" hidden>
<p><strong>Next step:</strong> reply to <a href="mailto:info@xylvar.top">info@xylvar.top</a>, or <a href="/#contact">talk through the fixes with us</a>.</p>
</div>
</div>
<p class="muted">This code is a lookup key for a complimentary report. It is not identity verification and it is not secure access. If you did not ask for an audit, you can ignore this page.</p>
<script>
const errEl = document.getElementById("error");
const form = document.getElementById("lookup");
const result = document.getElementById("result");
function showError(){ errEl.textContent = "That audit could not be found. Check the code and try again."; }
async function lookup(code, website){
  errEl.textContent = "";
  const q = new URLSearchParams({ code });
  if (website) q.set("website", website);
  const res = await fetch("/api/audit?" + q.toString());
  if (!res.ok){ showError(); return; }
  const d = await res.json();
  document.getElementById("intro").textContent = "Here is your report.";
  form.hidden = true;
  document.getElementById("r-business").textContent = d.business;
  document.getElementById("r-title").textContent = d.title;
  document.getElementById("r-meta").textContent = d.website + " | Report date: " + d.report_date + " | " + d.pages + " pages";
  document.getElementById("r-findings").innerHTML = d.findings.map(function(f){
    const li = document.createElement("li"); li.textContent = f; return li.outerHTML;
  }).join("");
  const dl = document.getElementById("r-download");
  dl.href = "/api/audit/download?code=" + encodeURIComponent(code.toUpperCase());
  dl.addEventListener("click", function(){ document.getElementById("next").hidden = false; }, { once: true });
  result.hidden = false;
}
form.addEventListener("submit", function(e){
  e.preventDefault();
  lookup(document.getElementById("code").value.trim(), document.getElementById("website").value.trim());
});
const params = new URLSearchParams(window.location.search);
const pre = params.get("code");
if (pre){ lookup(pre, ""); }
</script>
</body>
</html>`;
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

// ---------- audit download routes (noindex) ----------
const AUDIT_NOT_FOUND = "That audit could not be found. Check the code and try again.";
const noindex = (_req, res, next) => { res.setHeader("X-Robots-Tag", "noindex"); next(); };
app.get("/audit", noindex, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(auditPageHtml());
});
app.get("/api/audit", noindex, async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip, "audit-lookup", 30, 600_000)) return res.status(429).json({ status: "error", message: "Too many lookups from this address. Please wait a few minutes." });
  const a = await getAudit(String(req.query.code || ""));
  if (!a) return res.status(404).json({ status: "error", message: AUDIT_NOT_FOUND });
  if (req.query.website !== undefined && String(req.query.website).trim()) {
    if (auditHost(req.query.website) !== auditHost(a.website)) {
      return res.status(404).json({ status: "error", message: AUDIT_NOT_FOUND });
    }
  }
  res.json(auditPublic(a));
});
app.get("/api/audit/download", noindex, async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip, "audit-download", 10, 600_000)) return res.status(429).json({ status: "error", message: "Too many downloads from this address. Please wait a few minutes." });
  const a = await getAudit(String(req.query.code || ""));
  if (!a || path.basename(a.pdf_file) !== a.pdf_file) {
    return res.status(404).json({ status: "error", message: AUDIT_NOT_FOUND });
  }
  const file = path.join(AUDIT_DIR, a.pdf_file);
  if (!fs.existsSync(file)) return res.status(404).json({ status: "error", message: AUDIT_NOT_FOUND });
  try {
    await recordAuditDownload(a.code);
  } catch (err) {
    console.error("[audit] download record failed", err.message);
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${a.pdf_file}"`);
  fs.createReadStream(file).pipe(res);
});
app.post("/api/admin/audits", requireAdmin, async (req, res) => {
  const v = validateAuditBody(req.body || {});
  if (v.error) return res.status(400).json({ status: "error", message: v.error });
  if (await getAudit(v.value.code)) return res.status(409).json({ status: "error", message: "That code is already in use." });
  try {
    await insertAudit(v.value);
  } catch (err) {
    console.error("[audit] insert failed", err.message);
    return res.status(500).json({ status: "error", message: "The audit could not be saved." });
  }
  res.status(201).json(auditPublic(v.value));
});
app.get("/api/admin/audits", requireAdmin, async (_req, res) => res.json(await listAuditsAdmin()));

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
