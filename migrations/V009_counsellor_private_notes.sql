CREATE TABLE IF NOT EXISTS counsellor_student_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, counsellor_id)
);

CREATE INDEX IF NOT EXISTS counsellor_student_notes_student_idx
  ON counsellor_student_notes (student_id, updated_at DESC);
