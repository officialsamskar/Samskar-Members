const { sendEmail } = require('./_resend');

// POST /api/send-invite
// Body: { to, subject, message }
//
// Sends a one-off notice/invite to a specific person (e.g. an employee
// or event invitee). "to" must be an email address.
//
// TEST-DOMAIN LIMITATION: while sending from onboarding@resend.dev, this
// will only deliver if "to" matches the email on your Resend account.
// Real staff/guest addresses won't receive anything until a verified
// domain is set up.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, message } = req.body || {};
  if (!to || !subject || !message) {
    return res.status(400).json({ error: 'to, subject, and message are required' });
  }

  try {
    await sendEmail({
      to,
      subject,
      html: `<p>${message.replace(/\n/g, '<br>')}</p><p>— Samskar</p>`,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-invite error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
