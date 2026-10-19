// DEVELOPMENT ONLY: fills the local database with fake demo members so you can preview the
// home page and suggestions on an empty site. Do NOT run this on a real, public site.
//   npm run seed:demo        (password for every demo account: demo12345)
const bcrypt = require('bcryptjs');
const { db, AVATAR_COLORS } = require('../src/db');
const places = require('../src/places');

const people = [
  ['man', ['Liam', 'Noah', 'Lucas', 'Ethan', 'Hugo', 'Leo', 'Adam', 'Jules', 'Omar', 'Rohan']],
  ['woman', ['Emma', 'Olivia', 'Chloe', 'Mia', 'Zoe', 'Lina', 'Sofia', 'Anna', 'Priya', 'Maya']],
  ['other', ['Alex', 'Sam', 'Robin', 'Charlie', 'Jordan']],
];
// most demo members live in Bengaluru so the feed is full when you test as a Bengaluru user
const home = ['karnataka-bengaluru-urban', 'karnataka-bengaluru-urban', 'karnataka-bengaluru-urban', 'karnataka-mysuru', 'maharashtra-pune', 'tamil-nadu-chennai', 'telangana-hyderabad'].filter((id) => places.isValid(id));
const tags = ['music', 'travel', 'movies', 'sports', 'gaming', 'cooking', 'reading', 'fitness', 'art', 'tech', 'photography', 'nature'];
const bios = ['Coffee first, then everything else.', 'Always up for a good conversation.', 'Weekend hiker, weekday dreamer.', 'Looking to meet new people.', 'Music, food and long walks.'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hash = bcrypt.hashSync('demo12345', 10);
const insert = db.prepare(`INSERT INTO users (username, email, display_name, password_hash, bio, avatar_color, place_id, state_id, gender, interested_in, birth_date, interests, onboarded)
  VALUES (@username, @email, @name, @hash, @bio, @color, @place, @state, @gender, @interested, @birth, @interests, 1)`);

let n = 0;
for (const [gender, names] of people) {
  for (const name of names) {
    const username = 'demo_' + name.toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
    const interests = [...tags].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 4)).join(',');
    insert.run({ username, email: username + '@demo.local', name, hash, bio: pick(bios), color: pick(AVATAR_COLORS), ...(() => { const id = pick(home); return { place: id, state: places.get(id).stateId }; })(), gender,
      interested: pick(['men', 'women', 'others']), birth: `${1983 + Math.floor(Math.random() * 20)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`, interests });
    n++;
  }
}
console.log(`Added ${n} demo members (password: demo12345). Development only.`);
