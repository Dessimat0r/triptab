import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// Keep the original table so existing migration history remains intact.
export const ledgers = sqliteTable('ledgers', {
  owner: text('owner').primaryKey(), revision: integer('revision').notNull().default(0), data: text('data').notNull(),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(), email: text('email').notNull(), displayName: text('display_name').notNull(), createdAt: text('created_at').notNull(),
});

export const trips = sqliteTable('trips', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), data: text('data').notNull(),
}, table => [index('trips_owner_idx').on(table.owner)]);

export const memberships = sqliteTable('memberships', {
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), memberId: text('member_id').notNull(),
}, table => [
  uniqueIndex('memberships_trip_user_idx').on(table.tripId, table.userId),
  uniqueIndex('memberships_trip_member_idx').on(table.tripId, table.memberId),
  index('memberships_user_idx').on(table.userId),
]);

export const invites = sqliteTable('invites', {
  tokenHash: text('token_hash').primaryKey(),
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull(), email: text('email'), expiresAt: text('expires_at').notNull(), usedBy: text('used_by'), createdBy: text('created_by').notNull(),
});

export const receipts = sqliteTable('receipts', {
  id: text('id').primaryKey(), owner: text('owner').notNull(),
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
}, table => [index('receipts_trip_idx').on(table.tripId)]);

export const syncState = sqliteTable('sync_state', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull().default(0), lastWrite: text('last_write').notNull().default(''),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), title: text('title').notNull(), body: text('body').notNull(), url: text('url').notNull().default('/'), createdAt: text('created_at').notNull(),
}, table => [index('notifications_user_created_idx').on(table.userId, table.createdAt)]);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(), userId: text('user_id').notNull(), createdAt: text('created_at').notNull(),
}, table => [index('push_subscriptions_user_idx').on(table.userId)]);
