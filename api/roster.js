const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// All of these must be set as Environment Variables in the Vercel project
// settings (Settings -> Environment Variables). Nothing sensitive is
// hardcoded in this file, so it's safe to commit / share / push to a repo.
const DATABASE_URL = process.env.DATABASE_URL;
// One passcode per role. The passcode a person enters decides who they are:
// the server works out the role from it, and nothing the browser sends (name,
// role) is trusted. ROSTER_PIN still works as a single shared passcode if
// neither of the role-specific ones is set.
const ROLE_PINS = [
  { role: "CEO", pin: process.env.ROSTER_PIN_CEO },
  { role: "Web Manager", pin: process.env.ROSTER_PIN_WEB_MANAGER }
].filter(function(r){ return !!r.pin; }).map(function(r){ return { role: r.role, pin: String(r.pin) }; });
if(!ROLE_PINS.length && process.env.ROSTER_PIN){ ROLE_PINS.push({ role: "Team", pin: String(process.env.ROSTER_PIN) }); }

function roleForPin(given){
  var g = Buffer.from(String(given || ""));
  var found = null;
  ROLE_PINS.forEach(function(r){
    var b = Buffer.from(r.pin);
    if(b.length === g.length && crypto.timingSafeEqual(b, g) && !found){ found = r.role; }
  });
  return found;
}

// Too many wrong passcodes from one address in a short time locks it out.
const MAX_FAILED_LOGINS = 10;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev"; // Resend's shared test sender; verify your own domain for production
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || ""; // admin inbox for leave-request alerts, etc.

// Optional: Tally API key, used to pull live form responses into the Intake tab.
// See SETUP.md. The form IDs below are the three forms created for this app
// (the ID is the last part of the form's share link, tally.so/r/<ID>); set the
// env vars only if you want to point Intake at different forms.
const TALLY_API_KEY = process.env.TALLY_API_KEY || "";
// Secret shared with Tally so that only real form submissions are accepted by
// /api/tally-webhook. Also used here to tell the app the intake is switched on.
const TALLY_SIGNING_SECRET = process.env.TALLY_SIGNING_SECRET || "";
const TALLY_FORM_IDS = {
  bookings: process.env.TALLY_BOOKINGS_FORM_ID || "xXGlx5",
  kyc: process.env.TALLY_KYC_FORM_ID || "RGOVK9",
  enrollment: process.env.TALLY_ENROLLMENT_FORM_ID || "obJk6P",
  existing: process.env.TALLY_EXISTING_FORM_ID || "1AjRpO",
  leave: process.env.TALLY_LEAVE_FORM_ID || "aQWkRW"
};
const MEMBER_ENROLLMENT_FORM_URL = process.env.MEMBER_ENROLLMENT_FORM_URL || "";

const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

// ---------------- mappers ----------------
function mapMember(r){
  return {
    id: r.id, memberCode: r.member_code, name: r.name, title: r.title, department: r.department,
    email: r.email, phone: r.phone, location: r.location,
    startDate: r.start_date ? String(r.start_date).slice(0,10) : null,
    status: r.status
  };
}
function mapLeave(r){
  return {
    id: r.id, memberId: r.employee_id, type: r.type,
    startDate: String(r.start_date).slice(0,10), endDate: String(r.end_date).slice(0,10),
    note: r.note, status: r.status, requestedBy: r.requested_by
  };
}
function mapPerformance(r){
  return { id: r.id, memberId: r.employee_id, date: String(r.date).slice(0,10), rating: r.rating, note: r.note, author: r.author };
}
function mapProject(r){
  return {
    id: r.id, name: r.name, description: r.description,
    currentMemberId: r.current_member_id, status: r.status,
    clientName: r.client_name, service: r.service,
    budget: r.budget != null ? Number(r.budget) : null,
    location: r.location, eventDate: r.event_date ? String(r.event_date).slice(0,10) : null
  };
}
function mapHandover(r){
  return {
    id: r.id, projectId: r.project_id, fromMemberId: r.from_member_id, toMemberId: r.to_member_id,
    note: r.note, handoverDate: String(r.handover_date).slice(0,10), notifyPrevious: r.notify_previous
  };
}
function mapReceipt(r){
  return {
    id: r.id, receiptNo: r.receipt_no, clientName: r.client_name, contact: r.contact,
    service: r.service, amount: Number(r.amount), paymentMode: r.payment_mode,
    projectId: r.project_id, note: r.note, issuedBy: r.issued_by,
    receiptDate: String(r.receipt_date).slice(0,10)
  };
}
function mapTestimonial(r){
  return {
    id: r.id, clientName: r.client_name, body: r.body, rating: r.rating,
    source: r.source, date: r.testimonial_date ? String(r.testimonial_date).slice(0,10) : null
  };
}
function mapKyc(r){
  return {
    id: r.id, fullName: r.full_name, idType: r.id_type, idNumber: r.id_number,
    phone: r.phone, email: r.email, address: r.address, source: r.source
  };
}
function mapService(r){
  return { id: r.id, name: r.name, description: r.description, active: r.active, sortOrder: r.sort_order };
}

// ---------------- email ----------------
async function sendEmail(to, subject, html){
  if(!RESEND_API_KEY || !to) return { skipped: true };
  try{
    var res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject: subject, html: html })
    });
    if(!res.ok){
      var errText = await res.text();
      console.error("Resend error", res.status, errText);
      return { ok:false, error: errText };
    }
    return { ok:true };
  }catch(err){
    console.error("Email send failed", err);
    return { ok:false, error: err.message };
  }
}

// ---------------- Intake (form responses stored in SQL) ----------------
// Tally sends every submission to /api/tally-webhook, which saves it in the
// intake_submissions table. The Intake tab reads it back from there.
function formatTimestamp(iso){
  if(!iso) return "";
  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// Returns rows shaped like the old sheet rows: one object per response, keyed
// by question title (plus "Timestamp"), newest first. The front end reads
// fields like row["Client Name"], so keep the form's question titles as listed
// in SETUP.md.
// The database stores each answer set as jsonb, which doesn't keep the order the
// questions were asked in, so put them back in the forms' own order (any extra
// questions go at the end). The first answer is what the Intake list shows as
// the person's name.
const INTAKE_FIELD_ORDER = {
  bookings: ["Client Name", "Phone", "Email", "Service", "Event Date", "Location", "Notes"],
  kyc: ["Full Name", "Phone", "Email", "Address"],
  enrollment: ["Full Name", "Job Title", "Department", "Email", "Phone", "Location"],
  leave: ["Full Name", "Member Code", "Leave Type", "Start Date", "End Date", "Reason"],
  existing: ["Client Name", "Phone", "Receipt Number", "What would you like to do?", "Service", "Event Date", "Location", "What should we update?", "How was your experience?", "Your feedback"]
};
function orderAnswers(key, data){
  var out = {};
  (INTAKE_FIELD_ORDER[key] || []).forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
  });
  Object.keys(data).forEach(function(k){
    if(!Object.prototype.hasOwnProperty.call(out, k)) out[k] = data[k];
  });
  return out;
}

async function readIntake(key){
  if(!TALLY_SIGNING_SECRET) return { configured:false, rows:[] };
  var found = await sql`SELECT id, submitted_at, data FROM intake_submissions WHERE form_key = ${key} ORDER BY submitted_at DESC LIMIT 500`;
  var rows = found.map(function(r){
    var data = (typeof r.data === "string") ? JSON.parse(r.data) : (r.data || {});
    return Object.assign({ "Timestamp": formatTimestamp(r.submitted_at) }, orderAnswers(key, data));
  });
  return { configured:true, rows: rows };
}

// One-tap setup: registers a Tally webhook for each form so submissions flow
// into /api/tally-webhook. Safe to run again (existing webhooks are updated).
async function connectTallyForms(hookUrl){
  var headers = { "Authorization": "Bearer " + TALLY_API_KEY, "Content-Type": "application/json" };
  var listRes = await fetch("https://api.tally.so/webhooks?limit=100", { headers: headers });
  if(listRes.status === 401 || listRes.status === 403){
    throw new Error("Tally rejected the API key. Check TALLY_API_KEY in Vercel.");
  }
  if(!listRes.ok) throw new Error("Couldn't read your Tally webhooks (status " + listRes.status + ").");
  var listed = await listRes.json();
  var existing = listed.webhooks || [];

  var results = [];
  var keys = Object.keys(TALLY_FORM_IDS);
  for(var i = 0; i < keys.length; i++){
    var key = keys[i], formId = TALLY_FORM_IDS[key];
    var match = existing.find(function(w){ return w.formId === formId && w.url === hookUrl; });
    var body = { formId: formId, url: hookUrl, eventTypes: ["FORM_RESPONSE"], signingSecret: TALLY_SIGNING_SECRET };
    var res;
    if(match){
      body.isEnabled = true;
      res = await fetch("https://api.tally.so/webhooks/" + encodeURIComponent(match.id), { method: "PATCH", headers: headers, body: JSON.stringify(body) });
    } else {
      res = await fetch("https://api.tally.so/webhooks", { method: "POST", headers: headers, body: JSON.stringify(body) });
    }
    results.push({ form: key, status: res.ok ? (match ? "updated" : "connected") : "failed", code: res.status });
  }
  return results;
}

// ---------------- Existing-customer check ----------------
// Tally can't look anything up while a form is being filled in, so responses
// to the Existing Customer form are checked here against your own records.
// A response only counts as "verified" when the receipt number exists, the
// phone number is one on file for that receipt's customer, and the name
// matches. Anything less is flagged so nobody acts on an unverified claim.
function last10(v){
  var d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}
function normName(v){ return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

async function annotateExisting(rows){
  var receipts = await sql`SELECT receipt_no, client_name, contact FROM receipts`;
  var kycs = await sql`SELECT full_name, phone FROM kyc_records`;

  return rows.map(function(row){
    var phone = last10(row["Phone"]);
    var name = normName(row["Client Name"]);
    var rno = String(row["Receipt Number"] || "").trim().toUpperCase();
    var receipt = rno ? receipts.find(function(r){ return String(r.receipt_no || "").toUpperCase() === rno; }) : null;

    var status = "none", customer = "", note = "";
    if(receipt){
      var recName = normName(receipt.client_name);
      customer = receipt.client_name;
      var phonesOnFile = [last10(receipt.contact)];
      receipts.forEach(function(r){ if(normName(r.client_name) === recName) phonesOnFile.push(last10(r.contact)); });
      kycs.forEach(function(k){ if(normName(k.full_name) === recName) phonesOnFile.push(last10(k.phone)); });
      var phoneOk = !!phone && phonesOnFile.indexOf(phone) !== -1;
      var nameOk = name.length >= 3 && (name === recName || recName.indexOf(name) !== -1 || name.indexOf(recName) !== -1);
      if(phoneOk && nameOk){
        status = "verified"; note = "Receipt, phone and name all match your records.";
      } else if(phoneOk){
        status = "partial"; note = "Receipt and phone match, but the name differs from the receipt (" + receipt.client_name + ").";
      } else {
        status = "partial"; note = "That receipt exists, but this phone number isn't on file for " + receipt.client_name + ".";
      }
    } else {
      var byPhone = null;
      if(phone){
        var k = kycs.find(function(x){ return last10(x.phone) === phone; });
        var r = receipts.find(function(x){ return last10(x.contact) === phone; });
        byPhone = k ? k.full_name : (r ? r.client_name : null);
      }
      if(byPhone){
        status = "partial"; customer = byPhone;
        note = "This phone number is on file, but the receipt number doesn't match any receipt.";
      } else {
        note = "Nothing in your records matches this receipt number or phone number.";
      }
    }
    var out = Object.assign({}, row);
    out["__match"] = status;
    out["__matchName"] = customer;
    out["__matchNote"] = note;
    return out;
  });
}

// ---------------- Leave-application check ----------------
// A leave application only counts as verified when the member code belongs to
// a real member on the roster, the name matches that member, and the dates
// make sense. Only verified ones get the "Add to leave requests" button.
async function annotateLeave(rows){
  var members = await sql`SELECT id, member_code, name FROM employees`;
  return rows.map(function(row){
    var code = String(row["Member Code"] || "").trim().toUpperCase();
    var name = normName(row["Full Name"]);
    var member = code ? members.find(function(m){ return String(m.member_code || "").toUpperCase() === code; }) : null;
    var status = "none", customer = "", memberId = "", note = "";
    if(!member){
      note = code ? "No member on the roster has this member code." : "No member code was given.";
    } else {
      customer = member.name; memberId = member.id;
      var mn = normName(member.name);
      var nameOk = name.length >= 3 && (name === mn || mn.indexOf(name) !== -1 || name.indexOf(mn) !== -1);
      if(nameOk){
        status = "verified"; note = "Member code and name match the roster.";
        var start = String(row["Start Date"] || ""), end = String(row["End Date"] || "");
        var okDate = /^\d{4}-\d{2}-\d{2}$/;
        if(!okDate.test(start) || !okDate.test(end) || end < start){
          status = "partial"; note = "Member matches, but the dates look wrong (a date is missing, or the end is before the start).";
        }
      } else {
        status = "partial"; note = "That member code belongs to " + member.name + ", but the name entered is different.";
      }
    }
    var out = Object.assign({}, row);
    out["__match"] = status;
    out["__matchName"] = customer;
    out["__matchNote"] = note;
    out["__memberId"] = memberId;
    return out;
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if(!DATABASE_URL || !ROLE_PINS.length){
    res.status(500).json({ ok:false, error:"Server is missing DATABASE_URL or the passcodes (ROSTER_PIN_CEO / ROSTER_PIN_WEB_MANAGER). Set them in Vercel project settings." });
    return;
  }

  var pinHeader = req.headers['x-roster-pin'];
  var ip = String(req.headers['x-forwarded-for'] || "").split(",")[0].trim() || "unknown";

  // Locked out? Checked before the passcode, so guessing can't just carry on.
  try{
    var recent = await sql`SELECT count(*)::int AS n FROM auth_failures WHERE ip = ${ip} AND at > now() - interval '15 minutes'`;
    if(recent[0] && recent[0].n >= MAX_FAILED_LOGINS){
      res.status(429).json({ ok:false, error:"Too many wrong passcodes. Try again in 15 minutes." });
      return;
    }
  }catch(e){ console.error("Lockout check failed", e && e.message); }

  var role = roleForPin(pinHeader);
  if(!role){
    try{
      await sql`INSERT INTO auth_failures (ip) VALUES (${ip})`;
      await sql`DELETE FROM auth_failures WHERE at < now() - interval '1 day'`;
    }catch(e){ console.error("Could not record failed login", e && e.message); }
    res.status(401).json({ ok:false, error:"Incorrect passcode." });
    return;
  }

  try{
    if(req.method === 'GET'){
      var members = await sql`SELECT * FROM employees ORDER BY name ASC`;
      var leave = await sql`SELECT * FROM leave_requests ORDER BY created_at DESC`;
      var performance = await sql`SELECT * FROM performance_notes ORDER BY created_at DESC`;
      var projects = await sql`SELECT * FROM projects ORDER BY created_at DESC`;
      var handovers = await sql`SELECT * FROM project_handovers ORDER BY created_at DESC`;
      var receipts = await sql`SELECT * FROM receipts ORDER BY created_at DESC`;
      var testimonials = await sql`SELECT * FROM testimonials ORDER BY created_at DESC`;
      var kyc = await sql`SELECT * FROM kyc_records ORDER BY created_at DESC`;
      var services = await sql`SELECT * FROM services ORDER BY sort_order ASC, name ASC`;
      res.status(200).json({
        ok:true,
        role: role,
        members: members.map(mapMember),
        leave: leave.map(mapLeave),
        performance: performance.map(mapPerformance),
        projects: projects.map(mapProject),
        handovers: handovers.map(mapHandover),
        receipts: receipts.map(mapReceipt),
        testimonials: testimonials.map(mapTestimonial),
        kycRecords: kyc.map(mapKyc),
        services: services.map(mapService),
        // (name kept from the Google Sheets version so the front end needs no change)
        sheetsConfigured: {
          bookings: !!TALLY_SIGNING_SECRET,
          kyc: !!TALLY_SIGNING_SECRET,
          enrollment: !!TALLY_SIGNING_SECRET,
          existing: !!TALLY_SIGNING_SECRET,
          leave: !!TALLY_SIGNING_SECRET
        },
        memberEnrollmentFormUrl: MEMBER_ENROLLMENT_FORM_URL
      });
      return;
    }

    if(req.method === 'POST'){
      var body = req.body || {};
      var resource = body.resource;
      var action = body.action;
      var p = body.payload || {};
      // Who did it comes from the passcode, never from the browser.
      p.requestedBy = role; p.author = role; p.issuedBy = role;

      // ---------- connect Tally forms (register webhooks) ----------
      if(resource === 'tally' && action === 'connect'){
        if(!TALLY_API_KEY){ res.status(400).json({ ok:false, error:"TALLY_API_KEY isn't set in Vercel." }); return; }
        if(!TALLY_SIGNING_SECRET){ res.status(400).json({ ok:false, error:"TALLY_SIGNING_SECRET isn't set in Vercel." }); return; }
        var host = req.headers['x-forwarded-host'] || req.headers.host;
        var connectResults = await connectTallyForms("https://" + host + "/api/tally-webhook");
        res.status(200).json({ ok:true, results: connectResults });
        return;
      }

      // ---------- Tally intake ----------
      if(resource === 'sheet' && action === 'fetch'){
        if(!TALLY_FORM_IDS.hasOwnProperty(p.key)){ res.status(400).json({ ok:false, error:"Unknown intake form." }); return; }
        var sheetResult = await readIntake(p.key);
        if(p.key === 'existing' && sheetResult.configured){ sheetResult.rows = await annotateExisting(sheetResult.rows); }
        if(p.key === 'leave' && sheetResult.configured){ sheetResult.rows = await annotateLeave(sheetResult.rows); }
        res.status(200).json({ ok:true, configured: sheetResult.configured, rows: sheetResult.rows });
        return;
      }

      // ---------- members ----------
      if(resource === 'members' && action === 'create'){
        var codeRow = await sql`SELECT 'MBR-' || LPAD(nextval('member_code_seq')::text, 4, '0') AS code`;
        var memberCode = codeRow[0].code;
        await sql`
          INSERT INTO employees (id, member_code, name, title, department, email, phone, location, start_date, status)
          VALUES (${p.id}, ${memberCode}, ${p.name}, ${p.title||null}, ${p.department||null}, ${p.email||null}, ${p.phone||null}, ${p.location||null}, ${p.startDate||null}, ${p.status||'active'})
        `;
        res.status(200).json({ ok:true, memberCode: memberCode });
        return;
      }
      if(resource === 'members' && action === 'update'){
        await sql`
          UPDATE employees SET
            name=${p.name}, title=${p.title||null}, department=${p.department||null},
            email=${p.email||null}, phone=${p.phone||null}, location=${p.location||null},
            start_date=${p.startDate||null}, status=${p.status||'active'}
          WHERE id=${p.id}
        `;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'members' && action === 'delete'){
        await sql`DELETE FROM employees WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'members' && action === 'invite'){
        if(!p.email){ res.status(400).json({ ok:false, error:"An email address is required to send an invite." }); return; }
        var formLine = MEMBER_ENROLLMENT_FORM_URL
          ? "<p>Please fill out this short enrollment form to get started: <a href=\"" + MEMBER_ENROLLMENT_FORM_URL + "\">" + MEMBER_ENROLLMENT_FORM_URL + "</a></p>"
          : "<p>Your team will follow up shortly with next steps.</p>";
        var result = await sendEmail(
          p.email,
          "You're invited to join the Samskar team",
          "<p>Hi " + (p.name || "there") + ",</p><p>You've been invited to join the team at Samskar.</p>" +
          formLine +
          "<p>— The Roster</p>"
        );
        res.status(200).json({ ok:true, emailSkipped: !!result.skipped });
        return;
      }

      // ---------- leave ----------
      if(resource === 'leave' && action === 'create'){
        await sql`INSERT INTO leave_requests (id, employee_id, type, start_date, end_date, note, status, requested_by) VALUES (${p.id}, ${p.memberId}, ${p.type}, ${p.startDate}, ${p.endDate}, ${p.note||null}, 'pending', ${p.requestedBy||null})`;
        if(NOTIFY_EMAIL){
          var leaveEmpRows = await sql`SELECT name FROM employees WHERE id=${p.memberId}`;
          var leaveEmpName = (leaveEmpRows[0] && leaveEmpRows[0].name) || p.memberId;
          await sendEmail(
            NOTIFY_EMAIL,
            "Leave request: " + leaveEmpName,
            "<p><strong>Member:</strong> " + leaveEmpName + "</p>" +
            "<p><strong>Type:</strong> " + p.type + "</p>" +
            "<p><strong>Dates:</strong> " + p.startDate + " to " + p.endDate + "</p>" +
            (p.note ? "<p><strong>Note:</strong> " + p.note + "</p>" : "") +
            "<p>— The Roster</p>"
          );
        }
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'leave' && action === 'setStatus'){
        await sql`UPDATE leave_requests SET status=${p.status} WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'leave' && action === 'delete'){
        await sql`DELETE FROM leave_requests WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- performance ----------
      if(resource === 'performance' && action === 'create'){
        await sql`INSERT INTO performance_notes (id, employee_id, date, rating, note, author) VALUES (${p.id}, ${p.memberId}, ${p.date}, ${p.rating||null}, ${p.note}, ${p.author||null})`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'performance' && action === 'delete'){
        await sql`DELETE FROM performance_notes WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- projects ----------
      if(resource === 'projects' && action === 'create'){
        await sql`
          INSERT INTO projects (id, name, description, current_member_id, status, client_name, service, budget, location, event_date)
          VALUES (${p.id}, ${p.name}, ${p.description||null}, ${p.memberId}, 'active', ${p.clientName||null}, ${p.service||null}, ${p.budget||null}, ${p.location||null}, ${p.eventDate||null})
        `;
        var handoverId = p.id + '-h0';
        await sql`INSERT INTO project_handovers (id, project_id, from_member_id, to_member_id, note, notify_previous) VALUES (${handoverId}, ${p.id}, NULL, ${p.memberId}, ${p.note||null}, false)`;

        var toRows = await sql`SELECT name, email FROM employees WHERE id=${p.memberId}`;
        if(toRows[0] && toRows[0].email){
          await sendEmail(
            toRows[0].email,
            "New project assigned: " + p.name,
            "<p>Hi " + toRows[0].name + ",</p><p>A new project has been assigned to you:</p><p><strong>" + p.name + "</strong></p>" +
            (p.description ? "<p>" + p.description + "</p>" : "") +
            "<p>— The Roster</p>"
          );
        }
        res.status(200).json({ ok:true });
        return;
      }

      if(resource === 'projects' && action === 'handover'){
        var projRows = await sql`SELECT * FROM projects WHERE id=${p.id}`;
        var project = projRows[0];
        if(!project){ res.status(400).json({ ok:false, error:"Project not found." }); return; }
        var fromMemberId = project.current_member_id;

        await sql`UPDATE projects SET current_member_id=${p.toMemberId} WHERE id=${p.id}`;
        var handoverId = p.id + '-h' + Date.now().toString(36);
        var notifyPrevious = p.notifyPrevious !== false;
        await sql`INSERT INTO project_handovers (id, project_id, from_member_id, to_member_id, note, notify_previous) VALUES (${handoverId}, ${p.id}, ${fromMemberId||null}, ${p.toMemberId}, ${p.note||null}, ${notifyPrevious})`;

        var toRows2 = await sql`SELECT name, email FROM employees WHERE id=${p.toMemberId}`;
        if(toRows2[0] && toRows2[0].email){
          await sendEmail(
            toRows2[0].email,
            "Project handed over to you: " + project.name,
            "<p>Hi " + toRows2[0].name + ",</p><p>A project has been handed over to you:</p><p><strong>" + project.name + "</strong></p>" +
            (p.note ? "<p>" + p.note + "</p>" : "") +
            "<p>— The Roster</p>"
          );
        }
        if(notifyPrevious && fromMemberId){
          var fromRows = await sql`SELECT name, email FROM employees WHERE id=${fromMemberId}`;
          if(fromRows[0] && fromRows[0].email){
            await sendEmail(
              fromRows[0].email,
              "Project transferred: " + project.name,
              "<p>Hi " + fromRows[0].name + ",</p><p>Your project <strong>" + project.name + "</strong> has been transferred to another member.</p>" +
              "<p>— The Roster</p>"
            );
          }
        }
        res.status(200).json({ ok:true });
        return;
      }

      if(resource === 'projects' && action === 'delete'){
        await sql`DELETE FROM projects WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- receipts ----------
      if(resource === 'receipts' && action === 'create'){
        var rcptRow = await sql`SELECT 'RCPT-' || LPAD(nextval('receipt_code_seq')::text, 4, '0') AS code`;
        var receiptNo = rcptRow[0].code;
        var receiptDate = p.receiptDate||new Date().toISOString().slice(0,10);
        await sql`
          INSERT INTO receipts (id, receipt_no, client_name, contact, service, amount, payment_mode, project_id, note, issued_by, receipt_date)
          VALUES (${p.id}, ${receiptNo}, ${p.clientName}, ${p.contact||null}, ${p.service||null}, ${p.amount}, ${p.paymentMode||null}, ${p.projectId||null}, ${p.note||null}, ${p.issuedBy||null}, ${receiptDate})
        `;
        // If "contact" looks like an email, send the customer their receipt.
        if(p.contact && p.contact.indexOf("@") !== -1){
          await sendEmail(
            p.contact,
            "Your receipt from Samskar — " + receiptNo,
            "<p>Namaste " + p.clientName + ",</p>" +
            "<p>Your project has been received. Here is your receipt:</p>" +
            "<p><strong>Receipt No:</strong> " + receiptNo + "</p>" +
            (p.service ? "<p><strong>Service:</strong> " + p.service + "</p>" : "") +
            "<p><strong>Amount:</strong> " + p.amount + "</p>" +
            (p.paymentMode ? "<p><strong>Payment mode:</strong> " + p.paymentMode + "</p>" : "") +
            "<p><strong>Date:</strong> " + receiptDate + "</p>" +
            "<p>— Samskar</p>"
          );
          if(NOTIFY_EMAIL){
            await sendEmail(
              NOTIFY_EMAIL,
              "Receipt issued: " + receiptNo,
              "<p><strong>Client:</strong> " + p.clientName + " (" + p.contact + ")</p>" +
              "<p><strong>Amount:</strong> " + p.amount + "</p>"
            );
          }
        }
        res.status(200).json({ ok:true, receiptNo: receiptNo });
        return;
      }
      if(resource === 'receipts' && action === 'delete'){
        await sql`DELETE FROM receipts WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- testimonials ----------
      if(resource === 'testimonials' && action === 'create'){
        await sql`INSERT INTO testimonials (id, client_name, body, rating, source, testimonial_date) VALUES (${p.id}, ${p.clientName}, ${p.body}, ${p.rating||null}, ${p.source||'Manual'}, ${p.date||null})`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'testimonials' && action === 'delete'){
        await sql`DELETE FROM testimonials WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- kyc ----------
      if(resource === 'kyc' && action === 'create'){
        await sql`INSERT INTO kyc_records (id, full_name, id_type, id_number, phone, email, address, source) VALUES (${p.id}, ${p.fullName}, ${p.idType||null}, ${p.idNumber||null}, ${p.phone||null}, ${p.email||null}, ${p.address||null}, ${p.source||'Manual'})`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'kyc' && action === 'delete'){
        await sql`DELETE FROM kyc_records WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      // ---------- services ----------
      if(resource === 'services' && action === 'create'){
        await sql`INSERT INTO services (id, name, description, active, sort_order) VALUES (${p.id}, ${p.name}, ${p.description||null}, ${p.active!==false}, ${p.sortOrder||0})`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'services' && action === 'update'){
        await sql`UPDATE services SET name=${p.name}, description=${p.description||null}, active=${p.active!==false}, sort_order=${p.sortOrder||0} WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }
      if(resource === 'services' && action === 'delete'){
        await sql`DELETE FROM services WHERE id=${p.id}`;
        res.status(200).json({ ok:true });
        return;
      }

      res.status(400).json({ ok:false, error:"Unknown resource or action." });
      return;
    }

    res.status(405).json({ ok:false, error:"Method not allowed." });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error: err.message || "Server error." });
  }
};
