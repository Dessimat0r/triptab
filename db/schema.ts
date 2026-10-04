import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Keep the original table so existing migration history remains intact.
export const ledgers = sqliteTable('ledgers', {
  owner: text('owner').primaryKey(), revision: integer('revision').notNull().default(0), data: text('data').notNull(),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(), email: text('email').notNull(), displayName: text('display_name').notNull(), createdAt: text('created_at').notNull(),
});

export const authCredentials = sqliteTable('auth_credentials', {
  userId: text('user_id').primaryKey().references(() => profiles.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  iterations: integer('iterations').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('auth_credentials_email_idx').on(table.email)]);

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  index('auth_sessions_user_idx').on(table.userId),
  index('auth_sessions_expiry_idx').on(table.expiresAt),
]);

export const authLinks = sqliteTable('auth_links', {
  oaiUserId: text('oai_user_id').primaryKey(),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, table => [index('auth_links_user_idx').on(table.userId)]);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  keyHash: text('key_hash').primaryKey(),
  windowStart: integer('window_start').notNull(),
  attempts: integer('attempts').notNull(),
});

export const trips = sqliteTable('trips', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), data: text('data').notNull(),
  receiptLinkVersion: integer('receipt_link_version').notNull().default(0),
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
  auditId: text('audit_id').notNull().default(''),
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull(), email: text('email'), expiresAt: text('expires_at').notNull(), usedBy: text('used_by'), createdBy: text('created_by').notNull(),
});

export const receipts = sqliteTable('receipts', {
  id: text('id').primaryKey(), owner: text('owner').notNull(),
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  // Empty dates on historical uploads mean "unknown", not a fabricated age.
  createdAt: text('created_at').notNull().default(''),
  state: text('state', { enum: ['pending', 'active', 'deleting'] }).notNull().default('active'),
  contentType: text('content_type').notNull().default(''),
  sizeBytes: integer('size_bytes').notNull().default(0),
  sha256: text('sha256').notNull().default(''),
  // Migration grants unknown-age historical images a fresh cleanup grace.
  legacyCleanupAfter: text('legacy_cleanup_after').notNull().default(''),
}, table => [
  index('receipts_trip_idx').on(table.tripId),
  index('receipts_owner_idx').on(table.owner),
  index('receipts_cleanup_idx').on(table.state, table.createdAt),
  index('receipts_legacy_cleanup_idx').on(table.state, table.legacyCleanupAfter),
]);

export const syncState = sqliteTable('sync_state', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull().default(0), lastWrite: text('last_write').notNull().default(''),
});

// History deliberately has no cascading trip/account foreign keys: deleting a
// live record must never silently erase the record of who changed it.
export const activityEvents = sqliteTable('activity_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull(), tripId: text('trip_id').notNull(),
  actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
  createdAt: text('created_at').notNull(),
  entityType: text('entity_type', { enum: ['trip', 'member', 'expense', 'payment', 'draft', 'invite', 'receipt'] }).notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
  before: text('before_data'), after: text('after_data'),
  revision: integer('revision').notNull(),
  source: text('source', { enum: ['web', 'chatgpt', 'system'] }).notNull(),
}, table => [
  uniqueIndex('activity_events_id_idx').on(table.id),
  index('activity_events_trip_sequence_idx').on(table.tripId, table.sequence),
  index('activity_events_trip_entity_idx').on(table.tripId, table.entityType, table.entityId, table.sequence),
  index('activity_events_draft_before_expense_idx').on(table.tripId, sql`json_extract(before_data, '$.expenseId')`, table.entityId).where(sql`entity_type = 'draft'`),
  index('activity_events_draft_after_expense_idx').on(table.tripId, sql`json_extract(after_data, '$.expenseId')`, table.entityId).where(sql`entity_type = 'draft'`),
  index('activity_events_expense_before_source_draft_idx').on(table.tripId, sql`json_extract(before_data, '$.sourceDraftId')`, table.entityId).where(sql`entity_type = 'expense'`),
  index('activity_events_expense_after_source_draft_idx').on(table.tripId, sql`json_extract(after_data, '$.sourceDraftId')`, table.entityId).where(sql`entity_type = 'expense'`),
]);

// Rebuilt transactionally from each accepted trip snapshot. Scoped history
// reads metadata indexes rather than parsing the live ledger on every page.
export const currentReceiptLinks = sqliteTable('current_receipt_links', {
  tripId: text('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  entityType: text('entity_type', { enum: ['expense', 'draft'] }).notNull(),
  entityId: text('entity_id').notNull(), expenseId: text('expense_id'),
  sourceDraftId: text('source_draft_id'), receiptId: text('receipt_id'),
  hasExpenseLink: integer('has_expense_link').notNull().default(0),
}, table => [
  uniqueIndex('current_receipt_links_entity_idx').on(table.tripId, table.entityType, table.entityId),
  index('current_receipt_links_expense_idx').on(table.tripId, table.entityType, table.expenseId, table.entityId),
  index('current_receipt_links_source_idx').on(table.tripId, table.entityType, table.sourceDraftId, table.entityId),
  index('current_receipt_links_receipt_idx').on(table.tripId, table.entityType, table.receiptId, table.entityId),
]);

// Indexed historical link facts are append-only alongside their source event.
export const receiptHistoryLinks = sqliteTable('receipt_history_links', {
  tripId: text('trip_id').notNull(), entityType: text('entity_type', { enum: ['expense', 'draft'] }).notNull(),
  entityId: text('entity_id').notNull(), sequence: integer('sequence').notNull(),
  snapshotOrder: integer('snapshot_order').notNull(), expenseId: text('expense_id'),
  sourceDraftId: text('source_draft_id'), receiptId: text('receipt_id'),
  hasExpenseLink: integer('has_expense_link').notNull().default(0),
}, table => [
  uniqueIndex('receipt_history_links_snapshot_idx').on(table.sequence, table.snapshotOrder),
  index('receipt_history_links_entity_idx').on(table.tripId, table.entityType, table.entityId, table.sequence),
  index('receipt_history_links_expense_idx').on(table.tripId, table.entityType, table.expenseId, table.entityId),
  index('receipt_history_links_source_idx').on(table.tripId, table.entityType, table.sourceDraftId, table.entityId),
  index('receipt_history_links_receipt_idx').on(table.tripId, table.entityType, table.receiptId, table.entityId),
]);

// Immutable identity lookup survives deletion of every live receipt container.
export const receiptMessages = sqliteTable('receipt_messages', {
  tripId: text('trip_id').notNull(), messageId: text('message_id').notNull(), messageData: text('message_data').notNull(),
}, table => [uniqueIndex('receipt_messages_trip_message_idx').on(table.tripId, table.messageId)]);

// Account changes stay private; operational cleanup cannot erase their history.
export const accountActivityEvents = sqliteTable('account_activity_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull(), userId: text('user_id').notNull(),
  actorName: text('actor_name').notNull(), createdAt: text('created_at').notNull(),
  entityType: text('entity_type', { enum: ['profile', 'password', 'session', 'chatgpt', 'notifications'] }).notNull(),
  entityId: text('entity_id').notNull(), action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
  before: text('before_data'), after: text('after_data'),
  source: text('source', { enum: ['web', 'chatgpt', 'system'] }).notNull(),
}, table => [
  uniqueIndex('account_activity_events_id_idx').on(table.id),
  index('account_activity_events_user_sequence_idx').on(table.userId, table.sequence),
]);

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), title: text('title').notNull(), body: text('body').notNull(), url: text('url').notNull().default('/'), createdAt: text('created_at').notNull(),
}, table => [index('notifications_user_created_idx').on(table.userId, table.createdAt)]);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(), userId: text('user_id').notNull(), createdAt: text('created_at').notNull(),
  generation: text('generation').notNull().default(''),
}, table => [index('push_subscriptions_user_idx').on(table.userId)]);
