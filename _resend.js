// Shared helper — not an endpoint itself, imported by the functions below.
const FROM = 'Samskar <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Resend request failed (${res.status})`);
  }
  return data;
}

module.exports = { sendEmail };
