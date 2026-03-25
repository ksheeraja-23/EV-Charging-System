-- Migration: add address column to users table (if missing)
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS address VARCHAR(255) DEFAULT NULL;

-- Optional: add avatar and role columns if you want them
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar VARCHAR(255) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'Member';
