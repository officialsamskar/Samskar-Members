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
      if (!account.active) return send(res, 400, { error: 'This account has been deactivated. Contact an admin.' });
      const { token, maxAge } = await createSession(account.id);
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

    if (path === '/search' && method === 'GET') {
      const q = (req.query.q || '').toString().trim();
      if (!q) return send(res, 200, { notices: [], events: [], timetable: [] });
      const like = '%' + q + '%';
      const notices = await db.query('SELECT id, title, body FROM notices WHERE title ILIKE $1 OR body ILIKE $1 ORDER BY created_at DESC LIMIT 8', [like]);
      const events = await db.query('SELECT id, title, event_date, place, about FROM events WHERE title ILIKE $1 OR about ILIKE $1 OR place ILIKE $1 ORDER BY event_date DESC LIMIT 8', [like]);
      const timetable = await db.query('SELECT id, title, day_of_week, location FROM timetable_entries WHERE title ILIKE $1 OR location ILIKE $1 ORDER BY day_of_week LIMIT 8', [like]);
      return send(res, 200, { notices: notices.rows, events: events.rows, timetable: timetable.rows });
    }

    if (path === '/reports' && method === 'GET') {
      if (!adminOnly(user, res)) return;
      const leaveDays = (await db.query(
        `SELECT u.id, u.name, SUM((l.to_date - l.from_date) + 1)::int AS days
         FROM leaves l JOIN users u ON u.id = l.user_id
         WHERE l.status = 'approved' AND date_part('year', l.from_date) = date_part('year', current_date)
         GROUP BY u.id, u.name ORDER BY days DESC LIMIT 10`
      )).rows;
      const resourceUsage = (await db.query(
        `SELECT r.id, r.name, COUNT(t.id)::int AS slots,
                COALESCE(SUM(EXTRACT(EPOCH FROM (t.end_time - t.start_time)) / 3600), 0)::float AS hours
         FROM resources r LEFT JOIN timetable_entries t ON t.subject_resource_id = r.id
         GROUP BY r.id, r.name ORDER BY hours DESC`
      )).rows;
      const events = (await db.query(
        `SELECT e.id, e.title, e.event_date, e.cap, COUNT(rv.user_id)::int AS going
         FROM events e LEFT JOIN rsvps rv ON rv.event_id = e.id
         GROUP BY e.id, e.title, e.event_date, e.cap ORDER BY e.event_date DESC LIMIT 20`
      )).rows;
      return send(res, 200, { leaveDays, resourceUsage, events });
    }

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
      const rows = isAdmin(user)
        ? (await db.query(
            `SELECT id, name, email, phone, unit, role, active FROM users
             WHERE ($1 = '' OR name ILIKE '%'||$1||'%' OR unit ILIKE '%'||$1||'%') ORDER BY name`, [q]
          )).rows
        : (await db.query(
            `SELECT id, name, email, phone, unit, role, active FROM users
             WHERE listed = true AND active = true AND ($1 = '' OR name ILIKE '%'||$1||'%' OR unit ILIKE '%'||$1||'%') ORDER BY name`, [q]
          )).rows;
      return send(res, 200, { members: rows });
    }

    if (path === '/members-list' && method === 'GET') {
      return send(res, 200, { members: (await db.query('SELECT id, name FROM users WHERE active = true ORDER BY name')).rows });
    }

    // admin-only: deactivate or reactivate a member. Kills their live sessions too, so it takes effect immediately.
    if (parts[0] === 'members' && parts[2] === 'status' && method === 'POST') {
      if (!adminOnly(user, res)) return;
      const id = Number(parts[1]);
      if (id === user.id) return send(res, 400, { error: 'You can\'t deactivate your own account.' });
      const { active } = await readBody(req);
      await db.query('UPDATE users SET active=$1 WHERE id=$2', [!!active, id]);
      if (!active) await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      return send(res, 200, { ok: true });
    }

    // admin-only: add a new member account. Doesn't touch the admin's own session —
    // it just creates the row, so the new person logs in separately with what the admin gives them.
    if (path === '/members' && method === 'POST') {
      if (!adminOnly(user, res)) return;
      const { name = '', email = '', password = '' } = await readBody(req);
      const cleanName = name.trim(), cleanEmail = email.trim().toLowerCase();
      if (!cleanName) return send(res, 400, { error: 'Enter their full name.' });
      if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (password.length < 8) return send(res, 400, { error: 'Use a password with at least 8 characters.' });
      if ((await db.query('SELECT 1 FROM users WHERE email=$1', [cleanEmail])).rows.length) {
        return send(res, 400, { error: 'An account with that email already exists.' });
      }
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO users (member_no, name, email, password_hash) VALUES ('PENDING',$1,$2,$3) RETURNING id`,
        [cleanName, cleanEmail, await hashPassword(password)]
      );
      await db.query('UPDATE users SET member_no=$1 WHERE id=$2', ['M-' + (1000 + id), id]);
      return send(res, 200, { ok: true });
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

    // one-off changes: a whole-org holiday, or cancelling/moving a single occurrence of a recurring entry
    if (path === '/timetable/exceptions') {
      if (method === 'GET') {
        const { rows } = await db.query(
          `SELECT x.*, t.title AS entry_title, t.owner_id, t.subject_user_id
           FROM timetable_exceptions x LEFT JOIN timetable_entries t ON t.id = x.entry_id
           WHERE x.exception_date >= current_date - 1
           ORDER BY x.exception_date, x.new_start_time NULLS LAST`
        );
        return send(res, 200, { exceptions: rows });
      }
      if (method === 'POST') {
        const b = await readBody(req);
        if (!b.kind || !b.date) return send(res, 400, { error: 'Fill in the change.' });

        if (b.kind === 'holiday') {
          if (!adminOnly(user, res)) return;
          await db.query('INSERT INTO timetable_exceptions (kind, exception_date, note, created_by) VALUES (\'holiday\',$1,$2,$3)',
            [b.date, (b.note || '').trim(), user.id]);
          return send(res, 200, { ok: true });
        }

        if (b.kind === 'cancelled' || b.kind === 'moved') {
          const entryId = Number(b.entryId);
          const { rows: [entry] } = await db.query('SELECT owner_id, subject_user_id FROM timetable_entries WHERE id=$1', [entryId]);
          if (!entry) return send(res, 404, { error: 'That schedule entry no longer exists.' });
          if (!isAdmin(user) && entry.owner_id !== user.id && entry.subject_user_id !== user.id) {
            return send(res, 403, { error: 'You can only change entries you own.' });
          }
          if (b.kind === 'moved' && (!b.newDate || !b.newStart || !b.newEnd)) return send(res, 400, { error: 'Pick the new date and time.' });
          await db.query(
            `INSERT INTO timetable_exceptions (entry_id, kind, exception_date, new_date, new_start_time, new_end_time, note, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [entryId, b.kind, b.date, b.newDate || null, b.newStart || null, b.newEnd || null, (b.note || '').trim(), user.id]
          );
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'Unknown change type.' });
      }
    }
    if (parts[0] === 'timetable' && parts[1] === 'exceptions' && parts.length === 3 && method === 'DELETE') {
      const id = Number(parts[2]);
      const { rows: [x] } = await db.query(
        `SELECT x.created_by, t.owner_id, t.subject_user_id FROM timetable_exceptions x
         LEFT JOIN timetable_entries t ON t.id = x.entry_id WHERE x.id=$1`, [id]
      );
      if (!x) return send(res, 404, { error: 'Not found.' });
      if (!isAdmin(user) && x.created_by !== user.id && x.owner_id !== user.id && x.subject_user_id !== user.id) {
        return send(res, 403, { error: 'You can only undo changes you made.' });
      }
      await db.query('DELETE FROM timetable_exceptions WHERE id=$1', [id]);
      return send(res, 200, { ok: true });
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
