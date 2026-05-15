'use strict';

const express    = require('express');
const cors       = require('cors');
const { Resend } = require('resend');
const admin      = require('firebase-admin');

/* ================================================================
   INIT
   ================================================================ */
const app  = express();
const port = process.env.PORT || 3000;

// Parse JSON bodies up to 2mb (HTML newsletters can be large)
app.use(express.json({ limit: '2mb' }));

// CORS — allow CentralHub + TeachersHub origins
// (TeachersHub careers-admin + careers-apply hit /send-transactional)
const ALLOWED_ORIGINS = [
  'https://centralhub.eduversal.org',
  'https://central-hub.vercel.app',
  'https://teachershub.eduversal.org',
  'https://teachers-hub.vercel.app',
  // local dev
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman during testing)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
}));

/* ================================================================
   FIREBASE ADMIN (reads users + teacher_contacts, writes mail_campaigns)
   ================================================================ */
let db;
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set');
  const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || 'centralhub-8727b',
  });
  db = admin.firestore();
  console.log('Firebase Admin initialised');
} catch (err) {
  console.error('Firebase Admin init failed:', err.message);
  // Service still starts — send-campaign will return 500 if db is undefined
}

/* ================================================================
   RESEND CLIENT
   ================================================================ */
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = `${process.env.FROM_NAME || 'Eduversal Education'} <${process.env.FROM_EMAIL || 'secondary.edu@eduversal.org'}>`;
// Optional fallback Reply-To used by /send-transactional when caller omits it.
// Empty string = no Reply-To header added.
const DEFAULT_REPLY_TO = process.env.DEFAULT_REPLY_TO || '';

/* ================================================================
   AUTH MIDDLEWARE
   Expects: Authorization: Bearer <API_SECRET>
   ================================================================ */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* ================================================================
   HELPERS
   ================================================================ */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// HTML-escape merge tag values so a `<` in a password can't break out of an attribute / inject markup.
function escapeHtmlValue(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Substitute {{key}} (with optional whitespace) in `template` with vars[key].
// `escape` controls HTML-escaping: true for HTML body, false for plain-text subject.
// Missing keys render as empty string — safer than leaking the literal `{{password}}` to recipients.
function applyMergeTags(template, vars, { escape = true } = {}) {
  if (!template || !vars) return template || '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v == null) return '';
    return escape ? escapeHtmlValue(v) : String(v);
  });
}

/**
 * Build the HTML wrapper around the rich-editor body.
 * Adds a branded header, footer with unsubscribe placeholder.
 */
function buildEmailHtml(subject, bodyHtml, campaignId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>
  body { margin:0; padding:0; background:#f4f4f5; font-family:'Segoe UI',Arial,sans-serif; }
  .wrapper { max-width:620px; margin:32px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 16px rgba(0,0,0,.08); }
  .header  { background:linear-gradient(135deg,#1e3a5f 0%,#0d9488 100%); padding:28px 40px; }
  .header-logo { display:flex; align-items:center; gap:14px; }
  .header-logo img { display:block; height:30px; width:auto; }
  .header-logo .divider { display:inline-block; width:1px; height:22px; background:rgba(255,255,255,.28); }
  .header-logo .sub { color:rgba(255,255,255,.78); font-size:13px; font-weight:500; letter-spacing:.05em; text-transform:uppercase; }
  .body    { padding:36px 40px 28px; color:#1c1c2e; font-size:15px; line-height:1.6; }
  .body p  { margin:0 0 12px; }
  .body p:last-child { margin-bottom:0; }
  /* Quill emits empty paragraphs as <p><br></p> when the user hits Enter on a blank
     line. Without this, every empty paragraph stacks a full line-height + margin
     and the message looks double-spaced. Halve their visual weight. */
  .body p > br:only-child { line-height:0.6; }
  .body h1,.body h2,.body h3 { color:#0f172a; margin:18px 0 8px; }
  .body ul, .body ol { margin:0 0 12px; padding-left:22px; }
  .body li { margin-bottom:4px; }
  .body a  { color:#0d9488; }
  .body img { max-width:100%; border-radius:8px; }
  .footer  { background:#f8fafc; border-top:1px solid #e2e8f0; padding:20px 40px; font-size:12px; color:#94a3b8; text-align:center; }
  .footer a { color:#0d9488; text-decoration:none; }
  @media(max-width:640px){
    .header,.body,.footer { padding-left:20px; padding-right:20px; }
  }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="header-logo">
        <img src="https://centralhub.eduversal.org/eduversal-logo-white.png" alt="Eduversal" height="30">
        <span class="divider"></span>
        <span class="sub">Education</span>
      </div>
    </div>
    <div class="body">
      ${bodyHtml}
    </div>
    <div class="footer">
      <p>You are receiving this email because you are a teacher in the Eduversal network.</p>
      <p>Eduversal Education · Jakarta, Indonesia</p>
    </div>
  </div>
</body>
</html>`;
}

/* ================================================================
   TRANSACTIONAL TEMPLATES
   Variant-aware HTML wrapper for one-to-one emails (offers, interview
   invites, application confirmations, etc.). Distinct visual treatment
   per templateName so candidates can recognise the message type at a
   glance, but the same brand language as the newsletter wrapper.
   ================================================================ */
const TRANSACTIONAL_VARIANTS = {
  // Defaults — neutral mor/cyan brand (matches Eduversal design system)
  default: {
    headerGradient: 'linear-gradient(135deg,#1e3a5f 0%,#0d9488 100%)',
    accentColor:    '#0d9488',
    eyebrow:        '',
  },
  application_received: {
    headerGradient: 'linear-gradient(135deg,#1e3a5f 0%,#6c5ce7 100%)',
    accentColor:    '#6c5ce7',
    eyebrow:        'Application Received',
  },
  interview: {
    headerGradient: 'linear-gradient(135deg,#1e3a5f 0%,#6c5ce7 100%)',
    accentColor:    '#6c5ce7',
    eyebrow:        'Interview Scheduled',
  },
  offer: {
    headerGradient: 'linear-gradient(135deg,#0f766e 0%,#10b981 100%)',
    accentColor:    '#10b981',
    eyebrow:        'Offer of Employment',
  },
  reject: {
    headerGradient: 'linear-gradient(135deg,#334155 0%,#64748b 100%)',
    accentColor:    '#64748b',
    eyebrow:        'Application Update',
  },
};

/**
 * Build a branded transactional email (one recipient, one purpose).
 * Distinct from buildEmailHtml() which targets newsletters.
 */
function buildTransactionalHtml({ subject, bodyHtml, templateName, footerNote }) {
  const variant = TRANSACTIONAL_VARIANTS[templateName] || TRANSACTIONAL_VARIANTS.default;
  const eyebrow = variant.eyebrow
    ? `<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.85);font-weight:600;margin-bottom:8px">${variant.eyebrow}</div>`
    : '';
  const footer = footerNote
    ? `<p style="margin:0 0 6px">${footerNote}</p>`
    : `<p style="margin:0 0 6px">This is an automated message from the Eduversal hiring team.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>
  body { margin:0; padding:0; background:#f4f4f5; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Arial,sans-serif; }
  .wrapper { max-width:620px; margin:32px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 16px rgba(0,0,0,.08); }
  .header { background:${variant.headerGradient}; padding:28px 40px; }
  .header-logo { display:flex; align-items:center; gap:14px; }
  .header-logo img { display:block; height:30px; width:auto; }
  .header-logo .divider { display:inline-block; width:1px; height:22px; background:rgba(255,255,255,.28); }
  .header-logo .sub { color:rgba(255,255,255,.78); font-size:13px; font-weight:500; letter-spacing:.05em; text-transform:uppercase; }
  .body { padding:36px 40px 28px; color:#1c1c2e; font-size:15px; line-height:1.6; }
  .body h1, .body h2, .body h3 { color:#0f172a; margin:18px 0 8px; }
  .body a { color:${variant.accentColor}; }
  .body p { margin:0 0 12px; }
  .body p:last-child { margin-bottom:0; }
  .body p > br:only-child { line-height:0.6; }
  .body ul, .body ol { margin:0 0 12px; padding-left:22px; }
  .body li { margin-bottom:4px; }
  .body strong { color:#0f172a; }
  .body .cta {
    display:inline-block; padding:12px 22px; background:${variant.accentColor};
    color:#fff !important; text-decoration:none; border-radius:8px;
    font-weight:600; margin:8px 0;
  }
  .footer { background:#f8fafc; border-top:1px solid #e2e8f0; padding:18px 40px; font-size:12px; color:#94a3b8; text-align:center; }
  .footer a { color:${variant.accentColor}; text-decoration:none; }
  @media(max-width:640px) {
    .header, .body, .footer { padding-left:20px; padding-right:20px; }
  }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      ${eyebrow}
      <div class="header-logo">
        <img src="https://centralhub.eduversal.org/eduversal-logo-white.png" alt="Eduversal" height="30">
        <span class="divider"></span>
        <span class="sub">Education</span>
      </div>
    </div>
    <div class="body">
      ${bodyHtml}
    </div>
    <div class="footer">
      ${footer}
      <p style="margin:0">Eduversal Education · Jakarta, Indonesia</p>
    </div>
  </div>
</body>
</html>`;
}

/* ================================================================
   GET /health
   ================================================================ */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ================================================================
   PLATFORM CONFIG
   ================================================================ */
const PLATFORM_CONFIG = {
  centralhub:  { roleField: 'role_centralhub',  subRoleField: 'ch_sub_roles', userVal: 'central_user',   adminVal: 'central_admin'   },
  academichub: { roleField: 'role_academichub', subRoleField: 'ah_sub_roles', userVal: 'academic_user',  adminVal: 'academic_admin'  },
  teachershub: { roleField: 'role_teachershub', subRoleField: 'th_sub_roles', userVal: 'teachers_user',  adminVal: 'teachers_admin'  },
  researchhub: { roleField: 'role_researchhub', subRoleField: null,           userVal: 'research_user',  adminVal: 'research_admin'  },
};

/* ================================================================
   GET /recipients
   Query params (all optional — no params = all registered users):
     platform  = centralhub | academichub | teachershub | researchhub
     role      = user | admin | all  (default: all)
     subRole   = e.g. subject_teacher, school_principal …
     schoolId  = Firestore schools doc ID
   Also includes manual contacts from teacher_contacts collection.
   ================================================================ */
app.get('/recipients', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });

  try {
    const { platform, role = 'all', subRole, schoolId } = req.query;

    // School name lookup
    const schoolsSnap = await db.collection('schools').get();
    const schoolNameMap = {};
    schoolsSnap.docs.forEach(d => { schoolNameMap[d.id] = d.data().name || d.id; });

    // Build users query
    let usersQuery = db.collection('users');

    if (platform && PLATFORM_CONFIG[platform]) {
      const cfg = PLATFORM_CONFIG[platform];
      if (role === 'admin') {
        usersQuery = usersQuery.where(cfg.roleField, '==', cfg.adminVal);
      } else if (role === 'user') {
        usersQuery = usersQuery.where(cfg.roleField, '==', cfg.userVal);
      } else {
        // all = both user and admin
        usersQuery = usersQuery.where(cfg.roleField, 'in', [cfg.userVal, cfg.adminVal]);
      }
    } else {
      // No platform filter — return everyone who has any platform role
      // (fetch all, filter in JS to avoid composite index requirement)
    }

    if (schoolId) usersQuery = usersQuery.where('schoolId', '==', schoolId);

    // Manual contacts
    let contactsQuery = db.collection('teacher_contacts');
    if (schoolId) contactsQuery = contactsQuery.where('schoolId', '==', schoolId);

    const [usersSnap, contactsSnap] = await Promise.all([
      usersQuery.get(),
      contactsQuery.get(),
    ]);

    // Build de-duped map
    const map = new Map();

    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (!u.email) return;

      // No platform filter: skip users with no platform role at all
      if (!platform) {
        const hasAnyRole = ['role_centralhub','role_academichub','role_teachershub','role_researchhub']
          .some(f => u[f]);
        if (!hasAnyRole) return;
      }

      // Sub-role filter (JS-side — Firestore array-contains only supports one value)
      if (subRole && platform) {
        const cfg = PLATFORM_CONFIG[platform];
        const userSubRoles = cfg.subRoleField ? (u[cfg.subRoleField] || []) : [];
        if (!userSubRoles.includes(subRole)) return;
      }

      map.set(u.email.toLowerCase(), {
        email:      u.email,
        name:       u.displayName || '',
        schoolId:   u.schoolId   || '',
        schoolName: schoolNameMap[u.schoolId] || u.school || '',
        source:     'registered',
      });
    });

    contactsSnap.docs.forEach(d => {
      const c = d.data();
      if (!c.email) return;
      const key = c.email.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          email:      c.email,
          name:       c.name       || '',
          schoolId:   c.schoolId   || '',
          schoolName: c.schoolName || '',
          source:     'manual',
        });
      }
    });

    const recipients = Array.from(map.values());
    res.json({ count: recipients.length, recipients });

  } catch (err) {
    console.error('/recipients error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   GET /schools
   Returns unique schools from both users and teacher_contacts.
   ================================================================ */
app.get('/schools', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });

  try {
    // Build school list from actual schoolId values in users + teacher_contacts
    // so that schoolId filter in /recipients always matches
    const [usersSnap, contactsSnap, schoolsSnap] = await Promise.all([
      db.collection('users').where('role_teachershub', 'in', ['teachers_user', 'teachers_admin']).get(),
      db.collection('teacher_contacts').get(),
      db.collection('schools').get(),
    ]);

    // schoolId → schoolName lookup from schools collection
    const schoolNameMap = {};
    schoolsSnap.docs.forEach(d => {
      schoolNameMap[d.id] = d.data().name || d.id;
    });

    // Collect unique schoolIds that actually have recipients
    const schoolMap = new Map();
    usersSnap.docs.forEach(d => {
      const { schoolId, school } = d.data();
      if (!schoolId) return;
      if (!schoolMap.has(schoolId)) {
        schoolMap.set(schoolId, schoolNameMap[schoolId] || school || schoolId);
      }
    });
    contactsSnap.docs.forEach(d => {
      const { schoolId, schoolName } = d.data();
      if (!schoolId) return;
      if (!schoolMap.has(schoolId)) {
        schoolMap.set(schoolId, schoolNameMap[schoolId] || schoolName || schoolId);
      }
    });

    // Also include schools from the schools collection (even if no recipients yet)
    schoolsSnap.docs.forEach(d => {
      if (!schoolMap.has(d.id)) {
        schoolMap.set(d.id, d.data().name || d.id);
      }
    });

    const schools = Array.from(schoolMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ schools });
  } catch (err) {
    console.error('/schools error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   POST /send-campaign
   Body:
   {
     subject:      string,          // email subject
     bodyHtml:     string,          // rich HTML from Quill editor
     schoolIds:    string[],        // [] = all schools
     campaignName: string,          // for Firestore record
     sentBy:       string,          // admin email
   }
   ================================================================ */
app.post('/send-campaign', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });

  const { subject, bodyHtml, schoolIds = [], campaignName, sentBy,
          platform, role = 'all', subRole, excludedEmails = [],
          recipientEmails, personalizations } = req.body;

  // Validate
  if (!subject || !subject.trim())   return res.status(400).json({ error: 'subject is required' });
  if (!bodyHtml || !bodyHtml.trim()) return res.status(400).json({ error: 'bodyHtml is required' });

  // Personalization map: { [emailLower]: { [tag]: value } } — values substituted into {{tag}} in subject + body.
  // Field names recorded on the campaign doc; values are NEVER persisted (sensitive — passwords etc).
  const perMap = (personalizations && typeof personalizations === 'object') ? personalizations : null;
  const personalizationFields = perMap
    ? Array.from(new Set(Object.values(perMap).flatMap(v => v ? Object.keys(v) : []))).sort()
    : [];

  // ── 1. Collect recipients ──────────────────────────────────────
  let recipients;

  if (Array.isArray(recipientEmails) && recipientEmails.length > 0) {
    // Explicit list provided by client (new two-source architecture)
    recipients = recipientEmails
      .filter(e => typeof e === 'string' && e.includes('@'))
      .map(e => ({ email: e, name: '' }));
  } else {
    // Legacy: derive recipients from server-side filter
    let usersQuery    = db.collection('users');
    let contactsQuery = db.collection('teacher_contacts');

    if (platform && PLATFORM_CONFIG[platform]) {
      const cfg = PLATFORM_CONFIG[platform];
      if (role === 'admin') {
        usersQuery = usersQuery.where(cfg.roleField, '==', cfg.adminVal);
      } else if (role === 'user') {
        usersQuery = usersQuery.where(cfg.roleField, '==', cfg.userVal);
      } else {
        usersQuery = usersQuery.where(cfg.roleField, 'in', [cfg.userVal, cfg.adminVal]);
      }
    } else {
      usersQuery = usersQuery.where('role_teachershub', 'in', ['teachers_user', 'teachers_admin']);
    }

    if (schoolIds.length > 0) {
      usersQuery    = usersQuery.where('schoolId', 'in', schoolIds.slice(0, 30));
      contactsQuery = contactsQuery.where('schoolId', 'in', schoolIds.slice(0, 30));
    }

    const [usersSnap, contactsSnap] = await Promise.all([
      usersQuery.get(),
      contactsQuery.get(),
    ]);

    const excluded = new Set(excludedEmails.map(e => e.toLowerCase()));
    const map = new Map();
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (!u.email) return;
      if (excluded.has(u.email.toLowerCase())) return;
      if (subRole && platform && PLATFORM_CONFIG[platform].subRoleField) {
        const userSubRoles = u[PLATFORM_CONFIG[platform].subRoleField] || [];
        if (!userSubRoles.includes(subRole)) return;
      }
      map.set(u.email.toLowerCase(), { email: u.email, name: u.displayName || '' });
    });
    contactsSnap.docs.forEach(d => {
      const c = d.data();
      if (!c.email) return;
      const key = c.email.toLowerCase();
      if (excluded.has(key)) return;
      if (!map.has(key)) map.set(key, { email: c.email, name: c.name || '' });
    });
    recipients = Array.from(map.values());
  }

  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients found for the selected filter' });
  }

  // ── 2. Create campaign record in Firestore ─────────────────────
  const campaignRef = db.collection('mail_campaigns').doc();
  await campaignRef.set({
    campaignName:   campaignName || subject,
    subject,
    bodyHtml,
    schoolIds,
    platform:       platform || null,
    role:           role     || null,
    subRole:        subRole  || null,
    sentBy:         sentBy || '',
    recipientCount: recipients.length,
    sentCount:      0,
    failedCount:    0,
    status:         'sending',
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    // Field NAMES only — values would expose passwords / tokens in Firestore.
    personalizationFields,
    isPersonalized: personalizationFields.length > 0,
  });

  // ── 3. Send in batches of 50 (Resend batch limit) ──────────────
  // Respond immediately — sending happens async
  res.json({
    campaignId:     campaignRef.id,
    recipientCount: recipients.length,
    message:        'Campaign queued — sending in background',
  });

  // Background sending
  (async () => {
    // Pre-build the non-personalized HTML once; per-recipient path re-renders inside the loop.
    const baseHtml   = perMap ? null : buildEmailHtml(subject, bodyHtml, campaignRef.id);
    const batches    = chunk(recipients, 50);
    let sentCount    = 0;
    let failedCount  = 0;
    // Per-recipient delivery log. Stores email + name + status only — never field values.
    // Resend batch.send returns one id per email in input order, so we can map each id back.
    const recipientLog = [];

    for (const batch of batches) {
      const emails = batch.map(r => {
        let renderedSubject = subject;
        let renderedHtml    = baseHtml;
        if (perMap) {
          const vars = perMap[r.email.toLowerCase()] || null;
          // Per-recipient: substitute into subject (plain) + body (HTML-escape values), then wrap.
          renderedSubject = applyMergeTags(subject,  vars, { escape: false });
          renderedHtml    = buildEmailHtml(
            renderedSubject,
            applyMergeTags(bodyHtml, vars, { escape: true }),
            campaignRef.id
          );
        }
        return {
          from:    FROM,
          to:      r.name ? `${r.name} <${r.email}>` : r.email,
          subject: renderedSubject,
          html:    renderedHtml,
        };
      });

      try {
        const result  = await resend.batch.send(emails);
        // Always log the full response shape so Railway has a forensic
        // record of what Resend actually returned. Past incident
        // 2026-05-06: a batch returned no IDs and no .error, but the
        // service logged 38/38 'sent' anyway because the absent-IDs
        // branch was a console.warn instead of a throw.
        console.log('[send-campaign] Resend batch.send response:',
          JSON.stringify(result).slice(0, 800));

        // SDK v6 returns { data: [{id},...], error }. v0/v2 had
        // different shapes; normalise all so resendId logging works.
        if (result?.error) {
          throw new Error(result.error.message || JSON.stringify(result.error) || 'Resend batch error');
        }
        const idsArr  = Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result?.data?.data)
            ? result.data.data
            : [];

        // If Resend returned 200 but no IDs, the batch did NOT actually
        // send. Treat this as a hard failure — never log 'sent' with
        // null IDs (those mails are silently lost).
        if (idsArr.length === 0) {
          throw new Error(
            `Resend batch returned no IDs for ${batch.length} recipients. ` +
            `Likely cause: rate limit, domain warm-up, or SDK shape change. ` +
            `Raw response: ${JSON.stringify(result).slice(0, 400)}`
          );
        }
        if (idsArr.length !== batch.length) {
          // Partial response — log + treat extras as fail so we never
          // claim a 'sent' status without a real Resend ID behind it.
          console.warn('[send-campaign] Resend batch returned',
            idsArr.length, 'IDs for', batch.length, 'recipients — partial');
        }
        for (let i = 0; i < batch.length; i++) {
          const r  = batch[i];
          const id = idsArr[i]?.id || null;
          if (id) {
            recipientLog.push({ email: r.email, name: r.name || '', status: 'sent', resendId: id });
            sentCount += 1;
          } else {
            recipientLog.push({ email: r.email, name: r.name || '', status: 'failed', error: 'No Resend ID returned for this recipient' });
            failedCount += 1;
          }
        }
      } catch (batchErr) {
        const errMsg = batchErr?.message || 'Batch send error';
        console.error('[send-campaign] Batch send error:', errMsg);
        for (const r of batch) {
          recipientLog.push({
            email:  r.email,
            name:   r.name || '',
            status: 'failed',
            error:  errMsg.slice(0, 200), // cap to keep doc size sane
          });
        }
        failedCount += batch.length;
      }

      // Rate limit: 2 batches/sec (Resend free plan = 100 emails/sec)
      if (batches.indexOf(batch) < batches.length - 1) await sleep(600);
    }

    // ── 4. Update campaign record ──────────────────────────────
    // Firestore single-doc field cap is 1 MiB. Each recipient entry is <200 bytes,
    // so ~5000 recipients fit. For safety we cap at 2000 — beyond that the per-recipient
    // log is dropped (count fields still reflect totals so the UI degrades gracefully).
    const RECIPIENTS_LOG_CAP = 2000;
    const update = {
      sentCount,
      failedCount,
      status:   failedCount === 0 ? 'sent' : failedCount === recipients.length ? 'failed' : 'partial',
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (recipientLog.length <= RECIPIENTS_LOG_CAP) {
      update.recipients = recipientLog;
    } else {
      update.recipientsTruncated = true;
    }
    await campaignRef.update(update);

    console.log(`Campaign ${campaignRef.id}: sent=${sentCount} failed=${failedCount}`);
  })().catch(err => {
    console.error('Background send fatal error:', err);
    campaignRef.update({ status: 'failed', error: err.message }).catch(() => {});
  });
});

/* ================================================================
   POST /send-test
   Sends a test email to a single address (admin only, no campaign record)
   Body: { subject, bodyHtml, toEmail }
   ================================================================ */
app.post('/send-test', requireAuth, async (req, res) => {
  const { subject, bodyHtml, toEmail, previewVars } = req.body;
  if (!subject || !bodyHtml || !toEmail) {
    return res.status(400).json({ error: 'subject, bodyHtml, toEmail are required' });
  }

  try {
    // If admin passed previewVars (sample row from a CSV import), render merge tags
    // so the test email reflects what real recipients will receive.
    const hasVars = previewVars && typeof previewVars === 'object' && Object.keys(previewVars).length > 0;
    const renderedSubject = hasVars ? applyMergeTags(subject,  previewVars, { escape: false }) : subject;
    const renderedBody    = hasVars ? applyMergeTags(bodyHtml, previewVars, { escape: true })  : bodyHtml;
    const html = buildEmailHtml(renderedSubject, renderedBody, 'test');
    const { error } = await resend.emails.send({ from: FROM, to: toEmail, subject: `[TEST] ${renderedSubject}`, html });
    if (error) throw new Error(error.message || 'Resend rejected the email');
    res.json({ ok: true, message: `Test email sent to ${toEmail}` });
  } catch (err) {
    console.error('/send-test error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   POST /send-transactional
   One-to-one branded email (offers, interview invites, application
   confirmations). Distinct from /send-campaign — no Firestore
   campaign record, no batching.

   Body:
   {
     toEmail:       string                 (required)
     toName:        string                 (optional, used for "Name <email>")
     subject:       string                 (required)
     bodyHtml:      string                 (required — inner HTML, will be wrapped)
     templateName:  string                 (optional — application_received|interview|offer|reject|default)
     replyTo:       string                 (optional — falls back to DEFAULT_REPLY_TO env)
     footerNote:    string                 (optional — overrides default footer line)
     fromOverride:  string                 (optional — full "Name <email>" for FROM)
     tags:          { name, value }[]      (optional — Resend tags for analytics)
   }
   ================================================================ */
app.post('/send-transactional', requireAuth, async (req, res) => {
  const {
    toEmail, toName, subject, bodyHtml,
    templateName = 'default', replyTo, footerNote, fromOverride, tags,
  } = req.body || {};

  if (!toEmail || typeof toEmail !== 'string' || !toEmail.includes('@')) {
    return res.status(400).json({ error: 'toEmail is required and must be a valid address' });
  }
  if (!subject || !subject.trim())   return res.status(400).json({ error: 'subject is required' });
  if (!bodyHtml || !bodyHtml.trim()) return res.status(400).json({ error: 'bodyHtml is required' });

  try {
    const html = buildTransactionalHtml({ subject, bodyHtml, templateName, footerNote });
    const effectiveReplyTo = (typeof replyTo === 'string' && replyTo.includes('@'))
      ? replyTo
      : DEFAULT_REPLY_TO;

    const payload = {
      from:    fromOverride || FROM,
      to:      toName ? `${toName} <${toEmail}>` : toEmail,
      subject,
      html,
    };
    if (effectiveReplyTo) payload.replyTo = effectiveReplyTo;
    if (Array.isArray(tags) && tags.length) payload.tags = tags;

    const { data, error } = await resend.emails.send(payload);
    if (error) throw new Error(error.message || 'Resend rejected the email');

    res.json({
      ok: true,
      id: data?.id || null,
      message: `Sent to ${toEmail}`,
    });
  } catch (err) {
    console.error('/send-transactional error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   GET /campaigns
   Returns recent campaigns list (last 50)
   ================================================================ */
app.get('/campaigns', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });
  try {
    const snap = await db.collection('mail_campaigns')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    // List view: strip the per-recipient log + bodyHtml to keep response small.
    // Full detail comes from GET /campaigns/:id.
    const campaigns = snap.docs.map(d => {
      const data = d.data();
      const { recipients, bodyHtml, ...rest } = data;
      return {
        id: d.id,
        ...rest,
        createdAt:  data.createdAt?.toDate?.()?.toISOString() || null,
        finishedAt: data.finishedAt?.toDate?.()?.toISOString() || null,
      };
    });
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   GET /campaigns/:id
   Full campaign detail (recipients list + body HTML preview).
   ================================================================ */
app.get('/campaigns/:id', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });
  try {
    const doc = await db.collection('mail_campaigns').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Campaign not found' });
    const data = doc.data();
    // Cap bodyHtml at 500 KB on the wire — large data:image base64 inlines
    // would otherwise break JSON serialisation on the Express response and
    // surface as opaque 500s. The full body is still in Firestore for audit;
    // the modal only needs a preview.
    const PREVIEW_CAP = 500 * 1024;
    let bodyHtml = data.bodyHtml || '';
    let bodyTruncated = false;
    if (bodyHtml.length > PREVIEW_CAP) {
      bodyHtml = bodyHtml.slice(0, PREVIEW_CAP);
      bodyTruncated = true;
    }
    res.json({
      campaign: {
        id: doc.id,
        ...data,
        bodyHtml,
        bodyTruncated,
        createdAt:  data.createdAt?.toDate?.()?.toISOString() || null,
        finishedAt: data.finishedAt?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   GET /diag/last-resend-id
   Diagnostic helper — returns the last N recipient log entries from
   Firestore so you can quickly check if Resend gave us real message
   IDs (debugs the "Send Campaign sent but didn't arrive" mystery).
   Admin-only via the same bearer auth.
   ================================================================ */
app.get('/diag/last-resend-id', requireAuth, async (_req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });
  try {
    const snap = await db.collection('mail_campaigns')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    const out = [];
    for (const d of snap.docs) {
      const data = d.data();
      const recips = (data.recipients || []).map(r => ({
        email: r.email,
        status: r.status,
        resendId: r.resendId || null,
        error: r.error || null,
      }));
      out.push({
        id: d.id,
        subject: data.subject,
        sentBy: data.sentBy,
        status: data.status,
        sentCount: data.sentCount,
        failedCount: data.failedCount,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        recipients: recips,
      });
    }
    res.json({ campaigns: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   START
   ================================================================ */
app.listen(port, () => {
  console.log(`Eduversal Mail Service running on port ${port}`);
  console.log(`FROM: ${FROM}`);
  console.log(`DEFAULT_REPLY_TO: ${DEFAULT_REPLY_TO || '(none)'}`);
});
