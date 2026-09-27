const { sendEmail } = require('./_resend');

// POST /api/send-project-receipt
// Body: { customerName, customerEmail, projectName, amount, details }
//
// Call this right after a new project is successfully inserted into the
// database by an admin. Sends the customer a "project received" receipt,
// and optionally alerts the admin inbox too.
//
// TEST-DOMAIN LIMITATION: while sending from onboarding@resend.dev, this
// will NOT reach the customer's real address — only the email on your
// Resend account. A verified domain is required before this can go to
// actual customers.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { customerName, customerEmail, projectName, amount, details } = req.body || {};
  if (!customerName || !customerEmail || !projectName) {
    return res.status(400).json({ error: 'customerName, customerEmail, and projectName are required' });
  }

  try {
    // Receipt to the customer
    await sendEmail({
      to: customerEmail,
      subject: `Your project has been received — ${projectName}`,
      html: `
        <p>Namaste ${customerName},</p>
        <p>Your project has been received and added to our system. Here are the details:</p>
        <p>
          <strong>Project:</strong> ${projectName}<br>
          ${amount ? `<strong>Amount:</strong> ${amount}<br>` : ''}
          ${details ? `<strong>Details:</strong> ${details}<br>` : ''}
        </p>
        <p>We'll be in touch with next steps shortly.</p>
        <p>— Samskar</p>
      `,
    });

    // Copy to the admin inbox
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail({
        to: process.env.NOTIFY_EMAIL,
        subject: `New project added: ${projectName}`,
        html: `
          <p><strong>Customer:</strong> ${customerName} (${customerEmail})</p>
          <p><strong>Project:</strong> ${projectName}</p>
          ${amount ? `<p><strong>Amount:</strong> ${amount}</p>` : ''}
          ${details ? `<p><strong>Details:</strong> ${details}</p>` : ''}
        `,
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-project-receipt error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
