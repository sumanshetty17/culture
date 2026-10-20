// Verification codes (email + text message) can be switched on later without changing any code:
// set the environment variable REQUIRE_CODES=true (and set up SMTP and Twilio). Until then sign-up and login use a password only.
const codesRequired = () => /^(1|true|on|yes)$/i.test(String(process.env.REQUIRE_CODES || ''));
module.exports = { codesRequired };
