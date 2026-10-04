/** Visible activity and the accessible trip set change this tag; other trips do not. */
export async function ledgerEtag(database: D1Database, user: string): Promise<string> {
  const { results } = await database.prepare(`
    SELECT t.id, COALESCE(MAX(e.sequence), 0) AS latest
    FROM trips t LEFT JOIN activity_events e ON e.trip_id = t.id
    WHERE t.owner = ? OR EXISTS (
      SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?
    )
    GROUP BY t.id ORDER BY t.id
  `).bind(user, user).all<{ id: string; latest: number }>();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(results.map(row => [row.id, row.latest]))));
  const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `W/"triptab-${tag}"`;
}
