const { sendEmail } = require('./_resend');

// POST /api/send-booking-confirmation
// Body: { name, email, phone, service, message }
//
// TEST-DOMAIN LIMITATION: while sending from onboarding@resend.dev, Resend
// will only actually deliver to the email address on your Resend account —
// not to the customer's real address. Swap FROM in _resend.js to a verified
// domain address once one is set up, and this limitation goes away.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, phone, service, message } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    // Confirmation to the customer
    await sendEmail({
      to: email,
      subject: 'We received your enquiry — Samskar',
      html: `
        <p>Namaste ${name},</p>
        <p>Thank you for your enquiry${service ? ` about <strong>${service}</strong>` : ''}. We've received it and will get back to you shortly.</p>
        ${message ? `<p><em>Your message:</em> ${message}</p>` : ''}
        <p>— Samskar</p>
      `,
    });

    // Notification to the Samskar team
    await sendEmail({
      to: process.env.NOTIFY_EMAIL,
      subject: `New enquiry: ${name}`,
      html: `
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone || '—'}</p>
        <p><strong>Service:</strong> ${service || '—'}</p>
        <p><strong>Message:</strong> ${message || '—'}</p>
      `,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-booking-confirmation error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
