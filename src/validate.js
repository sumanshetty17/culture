const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// The exact wording people see in red under the sign-up fields
const MSG = {
  usernameFormat: 'Use 3 to 20 letters, numbers or underscores.',
  usernameTaken: 'This username is already taken, so try another one.',
  emailInvalid: 'Enter a valid email address.',
  emailTaken: 'This email already has an account.',
  phoneInvalid: 'Enter the number with its country code, for example +91 98765 43210.',
  phoneTaken: 'This phone number already has an account.',
  nameInvalid: 'Enter your name (up to 40 characters).',
};

// Phone numbers must include the country code, e.g. +33612345678
function normalizePhone(input) {
  let p = String(input || '').trim().replace(/[\s().-]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^0?[6-9]\d{9}$/.test(p)) p = '+91' + p.slice(-10); // Indian mobile typed without the country code
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

function passwordError(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 100) return 'Password is too long.';
  return null;
}

module.exports = { EMAIL_RE, USERNAME_RE, MSG, normalizePhone, passwordError };
