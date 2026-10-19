const express = require('express');
const { db, toPublicUser, ageFrom, splitInterests } = require('../db');
const { requireAuth, requireVerified, issueMediaCookie } = require('../auth');
const { privateUser } = require('./auth');
const presence = require('../presence');
const places = require('../places');

const router = express.Router();
router.use(requireAuth);
// Only the account itself (/me) is available before the email is verified.
router.use((req, res, next) => (req.path === '/me' ? next() : requireVerified(req, res, next)));

const GENDERS = ['man', 'woman', 'other'];
const INTERESTED_IN = ['men', 'women', 'others'];
const GENDER_FILTER = { men: 'man', women: 'woman', others: 'other' }; // each choice shows only that group

// Validates the profile fields. Anything not sent keeps its current value, so this
// works for both the first-time onboarding and later edits.
function parseProfile(body, current) {
  const has = (k) => body[k] !== undefined;
  const fail = (error) => ({ error });

  const name = has('displayName') ? String(body.displayName).trim() : current.display_name;
  if (name.length < 1 || name.length > 40) return fail('Name must be 1-40 characters.');

  const bio = has('bio') ? String(body.bio).trim() : current.bio;
  if (bio.length > 200) return fail('Bio can be at most 200 characters.');

  const placeId = has('placeId') ? String(body.placeId) : current.place_id;
  if (!placeId || !places.isValid(placeId)) return fail('Please choose your district from the list.');

  const gender = has('gender') ? body.gender : current.gender;
  if (!GENDERS.includes(gender)) return fail('Please choose whether you are a man, a woman or other.');

  const interestedIn = has('interestedIn') ? body.interestedIn : current.interested_in;
  if (!INTERESTED_IN.includes(interestedIn)) return fail('Please choose who you would like to meet.');

  const birthDate = has('birthDate') ? String(body.birthDate) : current.birth_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || '') || ageFrom(birthDate) === null) return fail('Please enter your date of birth.');
  const age = ageFrom(birthDate);
  if (age < 18) return fail('You must be at least 18 years old to use Connectly.');
  if (age > 100) return fail('Please enter a valid date of birth.');

  let interests = has('interests') ? body.interests : splitInterests(current.interests);
  if (!Array.isArray(interests)) return fail('Interests must be a list.');
  interests = [...new Set(interests.map((i) => String(i).toLowerCase().replace(/,/g, ' ').trim()).filter(Boolean))];
  if (interests.length > 8) return fail('Pick up to 8 interests.');
  if (interests.some((i) => i.length > 20)) return fail('Each interest can be at most 20 characters.');

  return { values: { display_name: name, bio, place_id: placeId, state_id: places.get(placeId).stateId, gender, interested_in: interestedIn, birth_date: birthDate, interests: interests.join(',') } };
}

function requireOnboarded(req, res, next) {
  if (!req.user.onboarded) return res.status(403).json({ error: 'Please complete your profile first.', code: 'onboarding' });
  next();
}

const genderFilterFor = (me) => GENDER_FILTER[me.interested_in];

// Where to look: the user's own district (default) or the whole state.
const scopeOf = (req) => (req.query.scope === 'state' ? 'state' : 'district');
const scopeSql = (scope) => (scope === 'state' ? 'state_id = @area' : 'place_id = @area');
const areaFor = (me, scope) => (scope === 'state' ? me.state_id : me.place_id);

router.get('/me', (req, res) => {
  issueMediaCookie(req, res, req.rawToken); // lets this browser load the protected photos and videos
  res.json({ user: privateUser(req.user) });
});

// Used by onboarding (first time) and by "edit profile". Completing it marks the account as onboarded.
router.put('/me', (req, res) => {
  const result = parseProfile(req.body || {}, req.user);
  if (result.error) return res.status(400).json({ error: result.error });
  db.prepare(
    `UPDATE users SET display_name = @display_name, bio = @bio, place_id = @place_id, state_id = @state_id, gender = @gender,
       interested_in = @interested_in, birth_date = @birth_date, interests = @interests, onboarded = 1
     WHERE id = @id`
  ).run({ ...result.values, id: req.user.id });
  res.json({ user: privateUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// Search by name or username, limited to the group the user said they want to meet.
router.get('/users/search', requireOnboarded, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 50);
  const esc = q.replace(/[\\%_]/g, (m) => '\\' + m);
  const scope = scopeOf(req);
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE id != @me AND onboarded = 1 AND gender = @gender AND ${scopeSql(scope)}
         AND (@q = '' OR username LIKE @like ESCAPE '\\' OR display_name LIKE @like ESCAPE '\\')
       ORDER BY (username LIKE @starts ESCAPE '\\' OR display_name LIKE @starts ESCAPE '\\') DESC, display_name COLLATE NOCASE
       LIMIT 30`
    )
    .all({ me: req.user.id, gender: genderFilterFor(req.user), area: areaFor(req.user, scope), q, like: `%${esc}%`, starts: `${esc}%` });
  res.json({ users: rows.map(toPublicUser) });
});

// People from the chosen group, ranked by how well they fit this user.
function rankFor(me, scope) {
  const rows = db
    .prepare(`SELECT * FROM users WHERE id != @me AND onboarded = 1 AND gender = @gender AND ${scopeSql(scope)} ORDER BY id DESC LIMIT 300`)
    .all({ me: me.id, gender: genderFilterFor(me), area: areaFor(me, scope) });

  const myInterests = splitInterests(me.interests);
  const myAge = ageFrom(me.birth_date);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  const scored = rows.map((r) => {
    let score = 0;
    const reasons = [];
    const online = presence.isOnline(r.id);
    if (online) { score += 30; reasons.push('Online now'); }
    const shared = splitInterests(r.interests).filter((i) => myInterests.includes(i));
    if (shared.length) {
      score += shared.length * 10;
      reasons.push(shared.length <= 2 ? `Both like ${shared.join(' & ')}` : `${shared.length} shared interests`);
    }
    if (r.place_id === me.place_id) { score += 15; if (scope === 'state') reasons.push('Same district'); }
    const age = ageFrom(r.birth_date);
    if (myAge !== null && age !== null) {
      const diff = Math.abs(age - myAge);
      score += Math.max(0, 10 - diff);
      if (diff <= 3) reasons.push('Similar age');
    }
    if (new Date(r.created_at).getTime() > weekAgo) { score += 5; reasons.push('New here'); }
    return { id: r.id, score, user: { ...toPublicUser(r), online, reasons: reasons.slice(0, 3) } };
  });
  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  return scored;
}

router.get('/users/suggestions', requireOnboarded, (req, res) => {
  res.json({ users: rankFor(req.user, scopeOf(req)).slice(0, 30).map((s) => s.user) });
});

// The home page: who is online, who fits you best, and who just joined, all from the chosen group.
router.get('/feed', requireOnboarded, (req, res) => {
  const me = req.user;
  const gender = genderFilterFor(me);
  const scope = scopeOf(req);
  const area = areaFor(me, scope);
  const ranked = rankFor(me, scope);
  const used = new Set();
  const take = (list, n) => { const out = list.slice(0, n); out.forEach((s) => used.add(s.id)); return out.map((s) => s.user); };

  const online = take(ranked.filter((s) => s.user.online), 10);
  const suggested = take(ranked.filter((s) => !used.has(s.id)), 12);
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const newMembers = take(
    ranked.filter((s) => !used.has(s.id) && new Date(s.user.createdAt).getTime() > cutoff).sort((a, b) => b.id - a.id), 8);

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE id != @me AND onboarded = 1 AND gender = @gender AND ${scopeSql(scope)}`)
    .get({ me: me.id, gender, area }).c;
  const onlineIds = presence.list().filter((id) => id !== me.id);
  let onlineCount = 0;
  if (onlineIds.length) {
    onlineCount = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE onboarded = 1 AND gender = ? AND ${scope === 'state' ? 'state_id' : 'place_id'} = ? AND id IN (${onlineIds.map(() => '?').join(',')})`)
      .get(gender, area, ...onlineIds).c;
  }
  res.json({ scope, counts: { total, online: onlineCount }, online, suggested, newMembers });
});

router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const count = (kind) => db.prepare('SELECT COUNT(*) AS c FROM media WHERE user_id = ? AND kind = ?').get(user.id, kind).c;
  res.json({ user: toPublicUser(user), online: presence.isOnline(user.id), counts: { photos: count('photo'), videos: count('video') } });
});

module.exports = router;
