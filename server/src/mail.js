import nodemailer from 'nodemailer';
import { getSetting } from './util.js';

export function isSmtpConfigured(db) {
  const s = getSetting(db, 'smtp');
  return !!(s && s.host && s.from);
}

export async function sendMail(db, { to, subject, text }) {
  if (!isSmtpConfigured(db)) throw new Error('smtp_not_configured');
  const s = getSetting(db, 'smtp');
  const transport = nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: !!s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
  await transport.sendMail({ from: s.from, to, subject, text });
}
