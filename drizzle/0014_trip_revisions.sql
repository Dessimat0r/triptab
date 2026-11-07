-- F-16: a per-trip revision, so a save conflicts only with changes to the same
-- holiday or bill. Triggers keep it current for every writer: a change to the
-- trip's data or owner, or to its memberships, advances it. The global
-- sync_state revision is unchanged and still versions whole-ledger snapshots.
ALTER TABLE trips ADD COLUMN revision integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER trips_revision_update AFTER UPDATE OF data,owner ON trips
WHEN OLD.data <> NEW.data OR OLD.owner <> NEW.owner
BEGIN
  UPDATE trips SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER memberships_revision_insert AFTER INSERT ON memberships
BEGIN
  UPDATE trips SET revision = revision + 1 WHERE id = NEW.trip_id;
END;
--> statement-breakpoint
CREATE TRIGGER memberships_revision_delete AFTER DELETE ON memberships
BEGIN
  UPDATE trips SET revision = revision + 1 WHERE id = OLD.trip_id;
END;
--> statement-breakpoint
CREATE TRIGGER memberships_revision_update AFTER UPDATE ON memberships
BEGIN
  UPDATE trips SET revision = revision + 1 WHERE id = OLD.trip_id OR id = NEW.trip_id;
END;
