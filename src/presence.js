// Tracks which users are online (a user can have several open tabs).
const sockets = new Map(); // userId -> number of connected sockets

module.exports = {
  add(userId) {
    const n = (sockets.get(userId) || 0) + 1;
    sockets.set(userId, n);
    return n === 1; // true if this made the user newly online
  },
  remove(userId) {
    const n = (sockets.get(userId) || 0) - 1;
    if (n <= 0) {
      sockets.delete(userId);
      return true; // user is now fully offline
    }
    sockets.set(userId, n);
    return false;
  },
  isOnline: (userId) => sockets.has(userId),
  list: () => [...sockets.keys()],
};
