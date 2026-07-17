export function ownedSource(db, userId, sourceId) {
  return db.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?").get(sourceId, userId) ?? null;
}

export function ownedConnection(db, userId) {
  return db.prepare("SELECT * FROM connections WHERE user_id = ?").get(userId) ?? null;
}
