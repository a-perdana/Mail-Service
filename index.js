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

// CORS — allow only CentralHub origins
const ALLOWED_ORIGINS = [
  'https://centralhub.eduversal.org',
  'https://central-hub.vercel.app',
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
  .header  { background:linear-gradient(135deg,#1e3a5f 0%,#0d9488 100%); padding:32px 40px; }
  .header-logo { font-size:1.35rem; font-weight:700; color:#fff; letter-spacing:.03em; }
  .header-logo span { color:#5eead4; }
  .body    { padding:36px 40px 28px; color:#1c1c2e; font-size:15px; line-height:1.7; }
  .body h1,.body h2,.body h3 { color:#0f172a; }
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
      <div class="header-logo">Eduversal <span>Education</span></div>
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
   GET /health
   ================================================================ */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ================================================================
   GET /recipients
   Returns the merged recipient list:
     - registered teachers (users with role_teachershub)
     - manual contacts (teacher_contacts collection)
   Optionally filtered by schoolId query param.
   ================================================================ */
app.get('/recipients', requireAuth, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase not initialised' });

  try {
    const { schoolId } = req.query;

    // 1. Registered teachers from users collection
    let usersQuery = db.collection('users')
      .where('role_teachershub', 'in', ['teachers_user', 'teachers_admin']);
    if (schoolId) usersQuery = usersQuery.where('schoolId', '==', schoolId);

    // 2. Manual contacts from teacher_contacts collection
    let contactsQuery = db.collection('teacher_contacts');
    if (schoolId) contactsQuery = contactsQuery.where('schoolId', '==', schoolId);

    const [usersSnap, contactsSnap] = await Promise.all([
      usersQuery.get(),
      contactsQuery.get(),
    ]);

    // Build de-duped map (email → recipient)
    const map = new Map();

    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (!u.email) return;
      map.set(u.email.toLowerCase(), {
        email:      u.email,
        name:       u.displayName || '',
        schoolId:   u.schoolId   || '',
        schoolName: u.school     || '',
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
    const schoolsSnap = await db.collection('schools').get();
    const schools = schoolsSnap.docs.map(d => ({
      id:   d.id,
      name: d.data().name || d.id,
    })).sort((a, b) => a.name.localeCompare(b.name));

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

  const { subject, bodyHtml, schoolIds = [], campaignName, sentBy } = req.body;

  // Validate
  if (!subject || !subject.trim())   return res.status(400).json({ error: 'subject is required' });
  if (!bodyHtml || !bodyHtml.trim()) return res.status(400).json({ error: 'bodyHtml is required' });

  // ── 1. Collect recipients ──────────────────────────────────────
  let usersQuery    = db.collection('users').where('role_teachershub', 'in', ['teachers_user', 'teachers_admin']);
  let contactsQuery = db.collection('teacher_contacts');

  if (schoolIds.length > 0) {
    // Firestore 'in' supports up to 30 values
    usersQuery    = usersQuery.where('schoolId', 'in', schoolIds.slice(0, 30));
    contactsQuery = contactsQuery.where('schoolId', 'in', schoolIds.slice(0, 30));
  }

  const [usersSnap, contactsSnap] = await Promise.all([
    usersQuery.get(),
    contactsQuery.get(),
  ]);

  const map = new Map();
  usersSnap.docs.forEach(d => {
    const u = d.data();
    if (!u.email) return;
    map.set(u.email.toLowerCase(), { email: u.email, name: u.displayName || '' });
  });
  contactsSnap.docs.forEach(d => {
    const c = d.data();
    if (!c.email) return;
    const key = c.email.toLowerCase();
    if (!map.has(key)) map.set(key, { email: c.email, name: c.name || '' });
  });

  const recipients = Array.from(map.values());

  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients found for the selected schools' });
  }

  // ── 2. Create campaign record in Firestore ─────────────────────
  const campaignRef = db.collection('mail_campaigns').doc();
  await campaignRef.set({
    campaignName:   campaignName || subject,
    subject,
    bodyHtml,
    schoolIds,
    sentBy:         sentBy || '',
    recipientCount: recipients.length,
    sentCount:      0,
    failedCount:    0,
    status:         'sending',
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
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
    const html      = buildEmailHtml(subject, bodyHtml, campaignRef.id);
    const batches   = chunk(recipients, 50);
    let sentCount   = 0;
    let failedCount = 0;

    for (const batch of batches) {
      try {
        const emails = batch.map(r => ({
          from:    FROM,
          to:      r.name ? `${r.name} <${r.email}>` : r.email,
          subject,
          html,
        }));

        const result = await resend.batch.send(emails);

        // Count successes / failures
        if (result?.data) {
          sentCount += result.data.length;
        } else {
          sentCount += batch.length;
        }
      } catch (batchErr) {
        console.error('Batch send error:', batchErr.message);
        failedCount += batch.length;
      }

      // Rate limit: 2 batches/sec (Resend free plan = 100 emails/sec)
      if (batches.indexOf(batch) < batches.length - 1) await sleep(600);
    }

    // ── 4. Update campaign record ──────────────────────────────
    await campaignRef.update({
      sentCount,
      failedCount,
      status:   failedCount === 0 ? 'sent' : failedCount === recipients.length ? 'failed' : 'partial',
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
  const { subject, bodyHtml, toEmail } = req.body;
  if (!subject || !bodyHtml || !toEmail) {
    return res.status(400).json({ error: 'subject, bodyHtml, toEmail are required' });
  }

  try {
    const html = buildEmailHtml(subject, bodyHtml, 'test');
    await resend.emails.send({ from: FROM, to: toEmail, subject: `[TEST] ${subject}`, html });
    res.json({ ok: true, message: `Test email sent to ${toEmail}` });
  } catch (err) {
    console.error('/send-test error:', err);
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
    const campaigns = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      createdAt:  d.data().createdAt?.toDate?.()?.toISOString() || null,
      finishedAt: d.data().finishedAt?.toDate?.()?.toISOString() || null,
    }));
    res.json({ campaigns });
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
});
