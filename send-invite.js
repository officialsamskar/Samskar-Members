const { sendEmail } = require('./_resend');

// POST /api/send-invite
// Body: { to, subject, message }                              — plain notice
//   or: { to, subject, memberName, username, tempPassword }    — invite with credentials
//
// Sends either a one-off notice, or (when username + tempPassword are
// present) an invite that includes login credentials for a new member.
// The member should be required to set a new password on first login.
//
// TEST-DOMAIN LIMITATION: while sending from onboarding@resend.dev, this
// will only deliver if "to" matches the email on your Resend account.
// Real staff/guest addresses won't receive anything until a verified
// domain is set up.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, message, memberName, username, tempPassword } = req.body || {};

  if (!to) {
    return res.status(400).json({ error: 'to is required' });
  }

  const isCredentialInvite = username && tempPassword;
  if (!isCredentialInvite && (!subject || !message)) {
    return res.status(400).json({
      error: 'Provide either { subject, message } for a plain notice, or { username, tempPassword } for a credential invite',
    });
  }

  const html = isCredentialInvite
    ? `
      <p>Namaste ${memberName || ''},</p>
      <p>You've been invited to join Samskar. Here are your login details:</p>
      <p>
        <strong>Username:</strong> ${username}<br>
        <strong>Temporary password:</strong> ${tempPassword}
      </p>
      <p>Please log in and set a new password on your first visit.</p>
      <p>— Samskar</p>
    `
    : `<p>${message.replace(/\n/g, '<br>')}</p><p>— Samskar</p>`;

  try {
    await sendEmail({
      to,
      subject: subject || 'Your Samskar invite',
      html,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-invite error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
