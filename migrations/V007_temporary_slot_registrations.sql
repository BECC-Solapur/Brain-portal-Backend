ALTER TABLE students
  ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) NOT NULL DEFAULT 'temporary';

ALTER TABLE students
  DROP CONSTRAINT IF EXISTS students_registration_status_check;

ALTER TABLE students
  ADD CONSTRAINT students_registration_status_check
  CHECK (registration_status IN ('temporary', 'permanent'));

CREATE OR REPLACE FUNCTION refresh_student_registration_status(target_student_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE students s
  SET registration_status = CASE
    WHEN s.user_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM inquiries i
      WHERE i.student_id = s.id
        AND i.fee_status = 'paid'
        AND i.deleted_at IS NULL
    ) THEN 'permanent'
    ELSE 'temporary'
  END,
  updated_at = NOW()
  WHERE s.id = target_student_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_student_registration_from_inquiry()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_student_registration_status(NEW.student_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_student_registration_from_student()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_student_registration_status(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inquiry_registration_status ON inquiries;
CREATE TRIGGER trg_inquiry_registration_status
AFTER INSERT OR UPDATE OF fee_status, student_id ON inquiries
FOR EACH ROW EXECUTE FUNCTION sync_student_registration_from_inquiry();

DROP TRIGGER IF EXISTS trg_student_registration_status ON students;
CREATE TRIGGER trg_student_registration_status
AFTER UPDATE OF user_id ON students
FOR EACH ROW
WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION sync_student_registration_from_student();

UPDATE students s
SET registration_status = CASE
  WHEN s.user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM inquiries i
    WHERE i.student_id = s.id AND i.fee_status = 'paid' AND i.deleted_at IS NULL
  ) THEN 'permanent'
  ELSE 'temporary'
END;
