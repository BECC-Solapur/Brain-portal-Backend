CREATE TABLE IF NOT EXISTS student_progress_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
  feedback_date DATE NOT NULL DEFAULT CURRENT_DATE,
  feedback_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, counsellor_id, feedback_date)
);

CREATE INDEX IF NOT EXISTS student_progress_feedback_student_date_idx
  ON student_progress_feedback (student_id, feedback_date DESC);
