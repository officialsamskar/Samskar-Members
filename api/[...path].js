// One function serves every /api/* route — Vercel's free plan caps how many
// functions a deployment can have, so the whole backend lives in this file.
const db = require('../lib/db');
const { send, readBody, parseCookies, setSessionCookie, clearSessionCookie } = require('../lib/http');
const { createSession, destroySession, getUserFromReq, hashPassword, verifyPassword } = require('../lib/auth');

const BAD_LOGIN = 'That email and password do not match. Check both and try again.';
const isAdmin = (user) => user.role === 'admin';
const adminOnly = (user, res) => isAdmin(user) || (send(res, 403, { error: 'Admins only.' }), false);

module.exports = async (req, res) => {
  try {
    // Parsed straight from the URL rather than req.query.path — more reliable
    // across Vercel's runtimes than depending on its dynamic-route query injection.
    const pathname = req.url.split('?')[0]; // e.g. '/api/events/12/rsvp'
    const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean); // ['events','12','rsvp']
    const path = '/' + parts.join('/');
    const { method } = req;

    // ---------- signed-out routes ----------
    if (path === '/login' && method === 'POST') {
      const { email = '', password = '' } = await readBody(req);
      const { rows: [account] } = await db.query('SELECT * FROM users WHERE email=$1', [email.trim().toLowerCase()]);
      if (!account || !(await verifyPassword(password, account.password_hash))) return send(res, 400, { error: BAD_LOGIN });
      const { token, maxAge } = await createSession(account.id);
      setSessionCookie(res, token, maxAge);
      return send(res, 200, { ok: true });
    }

    if (path === '/signup' && method === 'POST') {
      const { name = '', email = '', password = '' } = await readBody(req);
      const cleanName = name.trim(), cleanEmail = email.trim().toLowerCase();
      if (!cleanName) return send(res, 400, { error: 'Enter your full name.' });
      if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (password.length < 8) return send(res, 400, { error: 'Use a password with at least 8 characters.' });
      if ((await db.query('SELECT 1 FROM users WHERE email=$1', [cleanEmail])).rows.length) {
        return send(res, 400, { error: 'An account with that email already exists. Log in instead.' });
      }
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO users (member_no, name, email, password_hash) VALUES ('PENDING',$1,$2,$3) RETURNING id`,
        [cleanName, cleanEmail, await hashPassword(password)]
      );
      await db.query('UPDATE users SET member_no=$1 WHERE id=$2', ['M-' + (1000 + id), id]);
      const { token, maxAge } = await createSession(id);
      setSessionCookie(res, token, maxAge);
      return send(res, 200, { ok: true });
    }

    if (path === '/logout' && method === 'POST') {
      await destroySession(parseCookies(req).sh_session);
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }

    if (path === '/me' && method === 'GET') {
      const u = await getUserFromReq(req);
      if (!u) return send(res, 200, { user: null });
      const { id, member_no: memberNo, name, email, role, unit, phone, listed, since } = u;
      return send(res, 200, { user: { id, memberNo, name, email, role, unit, phone, listed, since } });
    }

    // ---------- everything below needs a session ----------
    const user = await getUserFromReq(req);
    if (!user) return send(res, 401, { error: 'Please log in.' });

    if (path === '/profile' && method === 'POST') {
      const { name = '', phone = '', unit = '', listed } = await readBody(req);
      if (!name.trim()) return send(res, 400, { error: 'Name cannot be empty.' });
      await db.query('UPDATE users SET name=$1, phone=$2, unit=$3, listed=$4 WHERE id=$5',
        [name.trim(), phone.trim(), unit.trim(), !!listed, user.id]);
      return send(res, 200, { ok: true });
    }

    if (path === '/password' && method === 'POST') {
      const { current = '', next = '', again = '' } = await readBody(req);
      if (!(await verifyPassword(current, user.password_hash))) return send(res, 400, { error: 'Current password is not correct.' });
      if (next.length < 8) return send(res, 400, { error: 'New password needs at least 8 characters.' });
      if (next !== again) return send(res, 400, { error: 'The new passwords do not match.' });
      if (next === current) return send(res, 400, { error: 'Choose a password you have not used before.' });
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(next), user.id]);
      return send(res, 200, { ok: true });
    }

    if (path === '/directory' && method === 'GET') {
      const q = (req.query.q || '').toString().trim();
      const { rows } = await db.query(
        `SELECT id, name, email, phone, unit, role FROM users
         WHERE listed = true AND ($1 = '' OR name ILIKE '%'||$1||'%' OR unit ILIKE '%'||$1||'%') ORDER BY name`, [q]
      );
      return send(res, 200, { members: rows });
    }

    if (path === '/members-list' && method === 'GET') {
      return send(res, 200, { members: (await db.query('SELECT id, name FROM users ORDER BY name')).rows });
    }

    // ---------- events ----------
    if (path === '/events') {
      if (method === 'GET') {
        const { rows } = await db.query(
          `SELECT e.*, COALESCE(json_agg(r.user_id) FILTER (WHERE r.user_id IS NOT NULL), '[]') AS going
           FROM events e LEFT JOIN rsvps r ON r.event_id = e.id
           WHERE e.event_date >= current_date GROUP BY e.id ORDER BY e.event_date ASC`
        );
        return send(res, 200, { events: rows });
      }
      if (method === 'POST') {
        if (!adminOnly(user, res)) return;
        const b = await readBody(req);
        if (!b.title || !b.date || !b.time || !b.place || !(Number(b.cap) > 0)) return send(res, 400, { error: 'Fill in all fields.' });
        const { rows: [{ id }] } = await db.query(
          `INSERT INTO events (title, event_date, event_time, place, cap, about, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [b.title.trim(), b.date, b.time.trim(), b.place.trim(), Number(b.cap), (b.about || '').trim(), user.id]
        );
        return send(res, 200, { ok: true, id });
      }
    }
    if (parts[0] === 'events' && parts[2] === 'rsvp' && method === 'POST') {
      const id = Number(parts[1]);
      const { rows: [ev] } = await db.query('SELECT cap FROM events WHERE id=$1', [id]);
      if (!ev) return send(res, 404, { error: 'Event not found.' });
      if ((await db.query('SELECT 1 FROM rsvps WHERE event_id=$1 AND user_id=$2', [id, user.id])).rows.length) {
        await db.query('DELETE FROM rsvps WHERE event_id=$1 AND user_id=$2', [id, user.id]);
        return send(res, 200, { ok: true, going: false });
      }
      const { rows: [{ c }] } = await db.query('SELECT count(*)::int AS c FROM rsvps WHERE event_id=$1', [id]);
      if (c >= ev.cap) return send(res, 400, { error: 'That event is full.' });
      await db.query('INSERT INTO rsvps (event_id, user_id) VALUES ($1,$2)', [id, user.id]);
      return send(res, 200, { ok: true, going: true });
    }
    if (parts[0] === 'events' && parts.length === 2 && method === 'DELETE') {
      if (!adminOnly(user, res)) return;
      await db.query('DELETE FROM events WHERE id=$1', [Number(parts[1])]);
      return send(res, 200, { ok: true });
    }

    // ---------- notices ----------
    if (path === '/notices') {
      if (method === 'GET') {
        return send(res, 200, { notices: (await db.query('SELECT * FROM notices ORDER BY pinned DESC, created_at DESC')).rows });
      }
      if (method === 'POST') {
        if (!adminOnly(user, res)) return;
        const b = await readBody(req);
        if (!b.title || !b.body) return send(res, 400, { error: 'Fill in title and message.' });
        await db.query('INSERT INTO notices (title, body, pinned, created_by) VALUES ($1,$2,$3,$4)',
          [b.title.trim(), b.body.trim(), !!b.pinned, user.id]);
        return send(res, 200, { ok: true });
      }
    }
    if (parts[0] === 'notices' && parts.length === 2 && method === 'DELETE') {
      if (!adminOnly(user, res)) return;
      await db.query('DELETE FROM notices WHERE id=$1', [Number(parts[1])]);
      return send(res, 200, { ok: true });
    }

    // ---------- leave requests ----------
    if (path === '/leaves') {
      if (method === 'GET') {
        const mine = await db.query('SELECT * FROM leaves WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
        const pending = isAdmin(user) ? (await db.query(
          `SELECT l.*, u.name AS user_name FROM leaves l JOIN users u ON u.id = l.user_id WHERE l.status = 'pending' ORDER BY l.created_at`
        )).rows : [];
        return send(res, 200, { mine: mine.rows, pending });
      }
      if (method === 'POST') {
        const b = await readBody(req);
        if (!b.from || !b.to || !b.type) return send(res, 400, { error: 'Fill in the leave request.' });
        if (b.to < b.from) return send(res, 400, { error: 'The end date must be on or after the start date.' });
        await db.query('INSERT INTO leaves (user_id, leave_type, from_date, to_date, reason) VALUES ($1,$2,$3,$4,$5)',
          [user.id, b.type, b.from, b.to, (b.reason || '').trim()]);
        return send(res, 200, { ok: true });
      }
    }
    if (parts[0] === 'leaves' && parts.length === 2 && method === 'POST') {
      const id = Number(parts[1]);
      const { action } = await readBody(req);
      if (action === 'cancel') {
        await db.query(`UPDATE leaves SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending'`, [id, user.id]);
        return send(res, 200, { ok: true });
      }
      if (action === 'approve' || action === 'decline') {
        if (!adminOnly(user, res)) return;
        await db.query('UPDATE leaves SET status=$1 WHERE id=$2', [action === 'approve' ? 'approved' : 'declined', id]);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'Unknown action.' });
    }

    // ---------- rooms & resources ----------
    if (path === '/resources') {
      if (method === 'GET') return send(res, 200, { resources: (await db.query('SELECT * FROM resources ORDER BY name')).rows });
      if (method === 'POST') {
        const { name = '', kind = 'room' } = await readBody(req);
        if (!name.trim()) return send(res, 400, { error: 'Name a room or resource.' });
        await db.query('INSERT INTO resources (name, kind, created_by) VALUES ($1,$2,$3)', [name.trim(), kind, user.id]);
        return send(res, 200, { ok: true });
      }
    }

    // ---------- timetable ----------
    if (path === '/timetable') {
      if (method === 'GET') {
        const { rows } = await db.query(
          `SELECT t.*, u.name AS subject_user_name, r.name AS subject_resource_name, o.name AS owner_name
           FROM timetable_entries t
           LEFT JOIN users u ON u.id = t.subject_user_id
           LEFT JOIN resources r ON r.id = t.subject_resource_id
           LEFT JOIN users o ON o.id = t.owner_id
           ORDER BY day_of_week, start_time`
        );
        return send(res, 200, { entries: rows });
      }
      if (method === 'POST') {
        const b = await readBody(req);
        if (!b.title || b.dayOfWeek == null || !b.start || !b.end) return send(res, 400, { error: 'Fill in the timetable entry.' });
        const forPerson = b.subjectType !== 'resource';
        const subjectUserId = forPerson ? Number(b.subjectUserId || user.id) : null;
        const subjectResourceId = forPerson ? null : Number(b.subjectResourceId);
        if (forPerson && subjectUserId !== user.id && !isAdmin(user)) return send(res, 403, { error: 'Only admins can schedule for someone else.' });
        await db.query(
          `INSERT INTO timetable_entries (owner_id, subject_type, subject_user_id, subject_resource_id, title, day_of_week, start_time, end_time, location, color)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [user.id, forPerson ? 'person' : 'resource', subjectUserId, subjectResourceId,
           b.title.trim(), Number(b.dayOfWeek), b.start, b.end, (b.location || '').trim(), b.color || null]
        );
        return send(res, 200, { ok: true });
      }
    }
    if (parts[0] === 'timetable' && parts.length === 2 && method === 'DELETE') {
      const id = Number(parts[1]);
      const clause = isAdmin(user) ? 'id=$1' : 'id=$1 AND (owner_id=$2 OR subject_user_id=$2)';
      await db.query(`DELETE FROM timetable_entries WHERE ${clause}`, isAdmin(user) ? [id] : [id, user.id]);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error(e); // full error goes to Vercel's logs; the visitor just sees a plain message
    send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
};
