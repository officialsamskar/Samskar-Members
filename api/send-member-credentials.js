const { sendEmail } = require('./_resend');

// POST /api/send-member-credentials
// Body: { memberName, memberEmail, username, tempPassword }
//
// Call this right after an admin creates a new member account. Sends
// login credentials to the member's personal email (the address entered
// by the admin in the member form).
//
// SECURITY NOTE: emailing a plaintext password is common but not best
// practice — anyone with mailbox access (or an old email backup) can log
// in later. Consider sending a one-time "set your password" link instead
// of a real tempPassword, if you'd like help wiring that up.
//
// TEST-DOMAIN LIMITATION: while sending from onboarding@resend.dev, this
// will NOT reach the member's real address — only the email on your
// Resend account. A verified domain is required before this can go to
// actual members.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { memberName, memberEmail, username, tempPassword } = req.body || {};
  if (!memberName || !memberEmail || !username || !tempPassword) {
    return res.status(400).json({
      error: 'memberName, memberEmail, username, and tempPassword are required',
    });
  }

  try {
    await sendEmail({
      to: memberEmail,
      subject: 'Your Samskar member account is ready',
      html: `
        <p>Namaste ${memberName},</p>
        <p>Your member account has been created. Here are your login details:</p>
        <p>
          <strong>Username:</strong> ${username}<br>
          <strong>Temporary password:</strong> ${tempPassword}
        </p>
        <p>Please log in and change your password as soon as possible.</p>
        <p>— Samskar</p>
      `,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-member-credentials error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
