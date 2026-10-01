CREATE TABLE IF NOT EXISTS student_progress_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  counsellor_id UUID NOT NULL REFERENCES counsellors(id) ON DELETE CASCADE,
  rating_month DATE NOT NULL DEFAULT DATE_TRUNC('month', CURRENT_DATE)::DATE,
  counsellor_progress SMALLINT NOT NULL CHECK (counsellor_progress BETWEEN 0 AND 100),
  career_clarity SMALLINT NOT NULL CHECK (career_clarity BETWEEN 0 AND 100),
  emotional_wellbeing SMALLINT NOT NULL CHECK (emotional_wellbeing BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, counsellor_id, rating_month)
);

CREATE INDEX IF NOT EXISTS student_progress_ratings_student_month_idx
  ON student_progress_ratings (student_id, rating_month DESC);
