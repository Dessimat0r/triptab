export type LedgerFreshness = {
  // Migration 0009 advances this counter atomically for every changed trips.data
  // write. Silent legacy normalization/repair need not emit participant activity.
  versions: { id: string; latest: number; dataVersion: number }[];
  links: { trip_id: string; user_id: string; member_id: string; email: string | null }[];
};

/** Hash visible body versions, activity and authoritative member account fields. */
export async function ledgerEtagForSnapshot({ versions, links }: LedgerFreshness): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    versions.map(row => [row.id, row.latest, row.dataVersion]),
    links.map(row => [row.trip_id, row.user_id, row.member_id, row.email]),
  ])));
  const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `W/"triptab-${tag}"`;
}

/** Metadata-only read; do not load financial JSON to answer an unchanged request. */
export async function readLedgerFreshness(database: D1Database, user: string) {
  const visibleIds = 'SELECT id FROM trips WHERE owner = ? UNION SELECT trip_id FROM memberships WHERE user_id = ?';
  const results = await database.batch([
    database.prepare(`SELECT t.id, t.receipt_link_version AS dataVersion,
      COALESCE((SELECT e.sequence FROM activity_events e WHERE e.trip_id = t.id ORDER BY e.sequence DESC LIMIT 1), 0) AS latest
      FROM trips t WHERE t.id IN (${visibleIds}) ORDER BY t.id`).bind(user, user),
    database.prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
    database.prepare(`SELECT m.trip_id, m.user_id, m.member_id, p.email FROM memberships m JOIN trips t ON t.id = m.trip_id
      LEFT JOIN profiles p ON p.id = m.user_id WHERE m.trip_id IN (${visibleIds})
      ORDER BY m.trip_id, m.member_id, m.user_id`).bind(user, user),
  ]);
  const freshness: LedgerFreshness = { versions: results[0].results as LedgerFreshness['versions'], links: results[2].results as LedgerFreshness['links'] };
  return { etag: await ledgerEtagForSnapshot(freshness), revision: (results[1].results as { revision: number }[])[0]?.revision || 0 };
}

/** Visible trip writes, activity and membership change the tag; unrelated trips do not. */
export async function ledgerEtag(database: D1Database, user: string): Promise<string> {
  return (await readLedgerFreshness(database, user)).etag;
}

/** If-None-Match uses weak comparison for GET and HEAD, including lists. */
export function ledgerTagMatches(condition: string | null, tag: string): boolean {
  return !!condition && condition.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === tag.replace(/^W\//, ''));
}
