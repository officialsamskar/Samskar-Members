# Samskar Members

A working members site: login/logout, profile & password, event sign-ups,
announcements, member directory, leave applications, and a weekly timetable
generator (people + rooms/resources). No dues or payments.

## What's here
- `index.html` — the whole front end (no build step, no framework)
- `api/` — serverless functions (Node.js, deploy as-is on Vercel)
- `lib/` — shared db/auth/http helpers used by the API routes
- `package.json` — dependencies: `pg`, `bcryptjs`

## Deploy (Vercel)
1. Push this folder to a GitHub repo (or `vercel deploy` directly from it).
2. In the Vercel project settings, add one environment variable:
   - `DATABASE_URL` — your Neon Postgres connection string
     (Neon dashboard → your project → Connection Details → include the
     `?sslmode=require` version, "pooled connection" is fine)
3. Deploy. No build command needed — it's static + serverless functions.

## Database
The schema (already created for you on Neon, project `samskar-members`,
id `winter-frost-75834845`) has these tables: `users`, `sessions`, `events`,
`rsvps`, `notices`, `leaves`, `resources`, `timetable_entries`.

One admin login already exists in that database:
- email: `admin@samskar.org`
- (ask me for the password, or reset it — see below)

To reset the admin password or add more admins directly in the database,
run in the Neon SQL editor:
```sql
update users set password_hash = '<bcrypt hash>' where email = 'admin@samskar.org';
```
Or just log in once deployed and use the Profile screen's "Change password" form.

## Notes
- Sessions are stored server-side in the `sessions` table and set as an
  HttpOnly cookie (`sh_session`), 30-day expiry.
- Passwords are hashed with bcrypt.
- Anyone can create a member account via the Join tab (creates role="member").
  Only existing admins can promote someone to admin (via SQL, for now).
