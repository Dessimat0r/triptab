-- R11: 0014's membership UPDATE trigger advanced the trip revision even when
-- nothing changed (for example an upsert that writes the same values), so an
-- unrelated save could look like a conflict. Only a real change to a
-- membership row advances it; a move between trips still advances both.
DROP TRIGGER IF EXISTS memberships_revision_update;
--> statement-breakpoint
CREATE TRIGGER memberships_revision_update AFTER UPDATE ON memberships
WHEN OLD.trip_id IS NOT NEW.trip_id OR OLD.user_id IS NOT NEW.user_id OR OLD.member_id IS NOT NEW.member_id
BEGIN
  UPDATE trips SET revision = revision + 1 WHERE id = OLD.trip_id OR id = NEW.trip_id;
END;
