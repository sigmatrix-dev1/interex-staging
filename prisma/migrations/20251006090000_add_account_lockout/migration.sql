-- Add account lockout tracking columns (Phase 1)
ALTER TABLE User ADD COLUMN failedLoginCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE User ADD COLUMN lockedUntil DATETIME NULL;
CREATE INDEX IF NOT EXISTS User_lockedUntil_idx ON User(lockedUntil);