ALTER TABLE students
  ADD COLUMN IF NOT EXISTS school_college_name VARCHAR(255);

COMMENT ON COLUMN students.address_line1 IS
  'Primary address supplied by the student during account registration.';

COMMENT ON COLUMN students.school_college_name IS
  'School or college supplied by the student during account registration.';
