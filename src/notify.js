// Sends verification codes by email (SMTP) and by text message (Twilio).
// Without credentials: in development the message is printed in the server console so you can
// test everything; in production (NODE_ENV=production) nothing is printed and sending is reported as unavailable.
const nodemailer = require('nodemailer');

const isProd = process.env.NODE_ENV === 'production';
const smtpOn = !!process.env.SMTP_HOST;
const twilioOn = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

const transporter = smtpOn
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const emailAvailable = () => smtpOn || !isProd;
const smsAvailable = () => twilioOn || !isProd;

function devLog(kind, to, text) {
  console.log(`\n[DEV ${kind} to ${to}]\n${text}\n`);
}

async function sendEmail(to, subject, text) {
  if (transporter) {
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
  } else if (!isProd) {
    devLog('EMAIL', to, `${subject}\n${text}`);
  } else {
    throw new Error('Email sending is not configured (set SMTP_HOST).');
  }
}

async function sendSms(to, body) {
  if (twilioOn) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const params = new URLSearchParams({ To: to, Body: body });
    if (/^MG/.test(process.env.TWILIO_FROM)) params.set('MessagingServiceSid', process.env.TWILIO_FROM);
    else params.set('From', process.env.TWILIO_FROM);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) throw new Error(`Twilio error ${res.status}`);
  } else if (!isProd) {
    devLog('SMS', to, body);
  } else {
    throw new Error('SMS sending is not configured (set TWILIO_* variables).');
  }
}

const codeMessage = (code) => `Your Connectly code is ${code}. It expires in 10 minutes. Never share it with anyone.`;

module.exports = { emailAvailable, smsAvailable, sendEmail, sendSms, codeMessage };
