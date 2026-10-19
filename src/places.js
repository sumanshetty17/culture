// The fixed list of places people can choose from ("District, State"), so nobody can misspell a place.
// To add or fix places, edit src/places.json.
const list = require('./places.json').map((p) => ({ ...p, label: `${p.district}, ${p.state}` }));
const byId = new Map(list.map((p) => [p.id, p]));

module.exports = {
  all: list,
  get: (id) => byId.get(id) || null,
  isValid: (id) => byId.has(id),
};
