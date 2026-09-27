const { sendEmail } = require('./_resend');

// POST /api/send-roster-notification
// Body: { type: 'leave_request' | 'attendance', employeeName, details }
//
// Call this from The Roster whenever a leave request is filed or an
// attendance event needs flagging. Sends to the admin/owner inbox
// (NOTIFY_EMAIL), not to the employee — see send-invite.js for
// employee-facing messages.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, employeeName, details } = req.body || {};
  if (!type || !employeeName) {
    return res.status(400).json({ error: 'type and employeeName are required' });
  }

  const subjectByType = {
    leave_request: `Leave request: ${employeeName}`,
    attendance: `Attendance update: ${employeeName}`,
  };

  try {
    await sendEmail({
      to: process.env.NOTIFY_EMAIL,
      subject: subjectByType[type] || `Roster update: ${employeeName}`,
      html: `
        <p><strong>Employee:</strong> ${employeeName}</p>
        <p><strong>Type:</strong> ${type}</p>
        <p><strong>Details:</strong> ${details || '—'}</p>
      `,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-roster-notification error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
