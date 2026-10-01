-- Migration: V010_student_profile_enhancements.sql
-- Ensure photo/avatar storage columns can hold long URLs or base64 data

ALTER TABLE students ALTER COLUMN photo_storage_key TYPE TEXT;
ALTER TABLE users ALTER COLUMN avatar_storage_key TYPE TEXT;

-- Add photo_url convenience column if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'students' AND column_name = 'photo_url'
  ) THEN
    ALTER TABLE students ADD COLUMN photo_url TEXT;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE users ADD COLUMN avatar_url TEXT;
  END IF;
END $$;
