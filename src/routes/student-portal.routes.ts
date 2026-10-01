import { Router, raw } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query } from '../config/db';

export const studentPortalRoutes = Router();
studentPortalRoutes.use(requireAuth());

async function access(req: import('express').Request, studentId: string) {
  const { rows: [student] } = await query<any>(
    'SELECT id, organization_id, user_id, full_name FROM students WHERE id=$1 AND deleted_at IS NULL', [studentId]
  );
  if (!student || student.organization_id !== req.auth!.orgId) throw ApiError.notFound('Student not found');
  if (student.user_id === req.auth!.userId) return { student, actor: 'student' as const };
  if (req.auth!.roles.includes('counsellor')) {
    const { rows } = await query<any>(`
      SELECT 1 FROM inquiries i 
      JOIN counsellors c ON (c.id = i.current_counsellor_id OR c.id = i.assigned_counsellor_id OR i.id IN (SELECT a.inquiry_id FROM appointments a WHERE a.counsellor_id = c.id))
      WHERE i.student_id=$1 AND c.user_id=$2 AND i.organization_id=$3 AND i.deleted_at IS NULL LIMIT 1
    `, [studentId, req.auth!.userId, req.auth!.orgId]);
    if (rows.length) return { student, actor: 'counsellor' as const };
  }
  throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'This student is not mapped to your account', 403);
}

studentPortalRoutes.get('/mapped', asyncHandler(async (req, res) => {
  if (!req.auth!.roles.includes('counsellor')) throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Counsellor access required', 403);
  const { rows } = await query<any>(`
    SELECT DISTINCT ON (s.id) s.id, s.full_name AS name, s.phone, s.email,
           s.school_college_name AS school,
           s.registration_number AS "regNo",
           COALESCE(p.name, paid_program.name, 'Module not assigned') AS program,
           COALESCE(i.current_class, p.grade_range, paid_program.grade_range, '—') AS standard,
           c.full_name AS counsellor,
           INITCAP(REPLACE(i.fee_status::text, '_', ' ')) AS fee,
           COALESCE(p.price, 0)::numeric AS "feeAmount",
           COALESCE(i.overall_progress_percent, 0)::int AS progress,
           i.status AS "inquiryStatus", i.status::text AS status,
           i.id AS "inquiryId",
           'Not set'::text AS "followUpCadence",
           CASE WHEN next_appointment.id IS NULL THEN 'Not scheduled'
             ELSE TO_CHAR(next_appointment.appointment_date, 'DD Mon YYYY') || ', ' ||
               COALESCE(next_appointment.slot_time_display, TO_CHAR(next_appointment.slot_start_time, 'HH12:MI AM'))
           END AS next
    FROM students s
    JOIN inquiries i ON i.student_id=s.id
    JOIN counsellors c ON (c.id = i.current_counsellor_id OR c.id = i.assigned_counsellor_id OR i.id IN (SELECT a.inquiry_id FROM appointments a WHERE a.counsellor_id = c.id))
    LEFT JOIN programs p ON p.id=i.program_id
    LEFT JOIN LATERAL (
      SELECT price_program.id AS program_id
      FROM payments pay
      JOIN LATERAL (
        SELECT candidate.id FROM programs candidate
        WHERE candidate.organization_id=i.organization_id
          AND candidate.is_active=TRUE
          AND candidate.price=pay.program_fee_amount
        ORDER BY candidate.sort_order, candidate.created_at LIMIT 1
      ) price_program ON TRUE
      WHERE pay.inquiry_id=i.id AND pay.status='paid'
      ORDER BY pay.paid_at DESC NULLS LAST, pay.created_at DESC LIMIT 1
    ) paid_payment ON TRUE
    LEFT JOIN programs paid_program ON paid_program.id=paid_payment.program_id
    LEFT JOIN LATERAL (
      SELECT a.id, a.appointment_date, a.slot_time_display, a.slot_start_time
      FROM appointments a
      WHERE a.inquiry_id=i.id AND a.status != 'cancelled'
      ORDER BY a.appointment_date DESC, a.slot_start_time DESC LIMIT 1
    ) next_appointment ON TRUE
    WHERE c.user_id=$1 AND i.organization_id=$2 AND i.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY s.id, i.created_at DESC
  `, [req.auth!.userId, req.auth!.orgId]);
  res.json(success(rows));
}));

studentPortalRoutes.get('/counsellor/dashboard-stats', asyncHandler(async (req, res) => {
  if (!req.auth!.roles.includes('counsellor')) throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Counsellor access required', 403);
  const { rows: [counsellor] } = await query<any>(`
    SELECT id FROM counsellors
    WHERE user_id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1
  `, [req.auth!.userId, req.auth!.orgId]);
  if (!counsellor) throw ApiError.notFound('Counsellor profile not found');
  const { rows: [stats] } = await query<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM appointments a
       WHERE a.counsellor_id=$1 AND a.organization_id=$2
         AND a.appointment_date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date
         AND a.status != 'cancelled') AS "meetingsToday",
      (SELECT COUNT(DISTINCT i.id)::int
       FROM inquiries i
       JOIN counselling_sessions cs ON cs.inquiry_id=i.id AND cs.status='completed'
       WHERE i.organization_id=$2 AND i.deleted_at IS NULL
         AND (i.assigned_counsellor_id=$1 OR i.current_counsellor_id=$1 OR cs.counsellor_id=$1)
         AND NOT EXISTS (
           SELECT 1 FROM conclusions conclusion
           WHERE conclusion.inquiry_id=i.id AND conclusion.is_draft=FALSE
         )) AS "pendingReports"
  `, [counsellor.id, req.auth!.orgId]);
  res.json(success(stats || { meetingsToday: 0, pendingReports: 0 }));
}));

studentPortalRoutes.get('/advice/latest', asyncHandler(async (req, res) => {
  if (!req.auth!.roles.includes('student')) {
    throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Student access required', 403);
  }
  const { rows: [advice] } = await query<any>(`
    SELECT c.id, c.conclusion_date AS "conclusionDate",
           c.session_summary AS "studyImprovement",
           c.observations AS "regularImprovement",
           c.finalized_at AS "publishedAt",
           co.full_name AS "counsellorName"
    FROM students s
    JOIN inquiries i ON i.student_id=s.id AND i.deleted_at IS NULL
    JOIN conclusions c ON c.inquiry_id=i.id AND c.organization_id=s.organization_id
      AND c.is_draft=FALSE
    JOIN counsellors co ON co.id=c.counsellor_id
    WHERE s.user_id=$1 AND s.organization_id=$2 AND s.deleted_at IS NULL
    ORDER BY c.finalized_at DESC NULLS LAST, c.created_at DESC LIMIT 1
  `, [req.auth!.userId, req.auth!.orgId]);
  res.json(success(advice || null));
}));

studentPortalRoutes.get('/parent/daily-updates', asyncHandler(async (req, res) => {
  if (!req.auth!.roles.includes('parent')) throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Parent access required', 403);
  const { rows: children } = await query<any>(`
    SELECT DISTINCT s.id, s.full_name AS name FROM parents p
    JOIN student_parents sp ON sp.parent_id=p.id
    JOIN students s ON s.id=sp.student_id
    WHERE p.user_id=$1 AND p.organization_id=$2 AND s.organization_id=$2
      AND p.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY name
  `, [req.auth!.userId, req.auth!.orgId]);
  const updates = await Promise.all(children.map(async (child: any) => {
    const { rows: actions } = await query<any>(`
      SELECT id, todo_text AS text, is_done AS done, due_date AS due
      FROM todos WHERE student_id=$1 AND due_date=CURRENT_DATE ORDER BY created_at, id
    `, [child.id]);
    const { rows: [feedback] } = await query<any>(`
      SELECT f.feedback_text AS text, f.feedback_date AS date, c.full_name AS "counsellorName"
      FROM student_progress_feedback f JOIN counsellors c ON c.id=f.counsellor_id
      WHERE f.student_id=$1 AND f.organization_id=$2
      ORDER BY f.feedback_date DESC, f.updated_at DESC LIMIT 1
    `, [child.id, req.auth!.orgId]);
    return { ...child, actions, feedback: feedback || null };
  }));
  res.json(success(updates));
}));

async function parentProfile(req: import('express').Request) {
  if (!req.auth!.roles.includes('parent')) throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Parent access required', 403);
  const { rows: [parent] } = await query<any>(
    'SELECT id FROM parents WHERE user_id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1',
    [req.auth!.userId, req.auth!.orgId]
  );
  if (!parent) throw ApiError.notFound('Parent profile not found');
  return parent;
}

studentPortalRoutes.get('/parent/information-form', asyncHandler(async (req, res) => {
  const parent = await parentProfile(req);
  const { rows: [form] } = await query<any>(
    'SELECT answers, status, submitted_at AS "submittedAt", updated_at AS "updatedAt" FROM parent_information_forms WHERE parent_id=$1',
    [parent.id]
  );
  res.json(success(form || { answers: {}, status: 'draft', submittedAt: null, updatedAt: null }));
}));

studentPortalRoutes.put('/parent/information-form', validate(z.object({
  answers: z.record(z.string().max(4000)),
  submit: z.boolean().default(false),
})), asyncHandler(async (req, res) => {
  const parent = await parentProfile(req);
  const { rows: [form] } = await query<any>(`
    INSERT INTO parent_information_forms (organization_id, parent_id, answers, status, submitted_at)
    VALUES ($1,$2,$3::jsonb,$4,CASE WHEN $5 THEN NOW() ELSE NULL END)
    ON CONFLICT (parent_id) DO UPDATE SET answers=EXCLUDED.answers,
      status=EXCLUDED.status,
      submitted_at=CASE WHEN $5 THEN NOW() ELSE parent_information_forms.submitted_at END,
      updated_at=NOW()
    RETURNING answers, status, submitted_at AS "submittedAt", updated_at AS "updatedAt"
  `, [req.auth!.orgId, parent.id, JSON.stringify(req.body.answers), req.body.submit ? 'submitted' : 'draft', req.body.submit]);
  res.json(success(form));
}));

studentPortalRoutes.post('/parent/feedback', validate(z.object({
  subject: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(5000),
})), asyncHandler(async (req, res) => {
  const parent = await parentProfile(req);
  const { rows: [child] } = await query<any>(`
    SELECT sp.student_id, i.id AS inquiry_id,
      COALESCE(i.assigned_counsellor_id, i.current_counsellor_id) AS counsellor_id
    FROM student_parents sp
    JOIN students s ON s.id=sp.student_id AND s.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT id, assigned_counsellor_id, current_counsellor_id
      FROM inquiries WHERE student_id=s.id AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    ) i ON TRUE
    WHERE sp.parent_id=$1 AND s.organization_id=$2
    ORDER BY sp.is_primary_contact DESC NULLS LAST, sp.created_at DESC
    LIMIT 1
  `, [parent.id, req.auth!.orgId]);
  if (!child) throw ApiError.notFound('No student is linked to this parent account');
  const { rows: [feedback] } = await query<any>(`
    INSERT INTO parent_feedback (
      organization_id, inquiry_id, student_id, parent_id, counsellor_id,
      feedback_text, feedback_category, is_visible_to_counsellor,
      is_visible_to_admin, submitted_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,NOW())
    RETURNING id, feedback_text AS message, feedback_category AS subject,
      submitted_at AS "submittedAt"
  `, [req.auth!.orgId, child.inquiry_id, child.student_id, parent.id,
    child.counsellor_id, req.body.message, req.body.subject]);
  res.status(201).json(success(feedback));
}));

studentPortalRoutes.get('/parent/child-progress', asyncHandler(async (req, res) => {
  if (!req.auth!.roles.includes('parent')) throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Parent access required', 403);
  const { rows: children } = await query<any>(`
    SELECT DISTINCT s.id, s.full_name AS name FROM parents p
    JOIN student_parents sp ON sp.parent_id=p.id
    JOIN students s ON s.id=sp.student_id
    WHERE p.user_id=$1 AND p.organization_id=$2 AND s.organization_id=$2
      AND p.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY name
  `, [req.auth!.userId, req.auth!.orgId]);
  const reports = await Promise.all(children.map(async (child: any) => {
    const { rows: [actionStats] } = await query<any>(`
      WITH daily AS (
        SELECT due_date, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_done)::int AS completed
        FROM todos WHERE student_id=$1
          AND due_date >= DATE_TRUNC('month', CURRENT_DATE)::DATE
          AND due_date < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')::DATE
        GROUP BY due_date
      )
      SELECT COALESCE(SUM(total), 0)::int AS total,
        COALESCE(SUM(completed), 0)::int AS completed,
        ROUND(AVG(completed::numeric * 100 / NULLIF(total, 0)))::int AS consistency
      FROM daily
    `, [child.id]);
    const consistency = actionStats.consistency;
    const { rows: [rating] } = await query<any>(`
      SELECT r.counsellor_progress AS "counsellorProgress", r.career_clarity AS "careerClarity",
        r.emotional_wellbeing AS "emotionalWellbeing", r.rating_month AS month,
        c.full_name AS "counsellorName"
      FROM student_progress_ratings r JOIN counsellors c ON c.id=r.counsellor_id
      WHERE r.student_id=$1 AND r.organization_id=$2
      ORDER BY r.rating_month DESC, r.updated_at DESC LIMIT 1
    `, [child.id, req.auth!.orgId]);
    const overall = rating
      ? Math.round(([rating.counsellorProgress, rating.careerClarity, rating.emotionalWellbeing, consistency]
          .filter((value): value is number => value !== null).reduce((sum, value) => sum + value, 0)) / (consistency === null ? 3 : 4))
      : null;
    return { ...child, overall, consistency, monthlyActions: actionStats, rating: rating || null };
  }));
  res.json(success(reports));
}));

studentPortalRoutes.post('/:id/progress-rating', validate(z.object({
  counsellorProgress: z.number().int().min(0).max(100),
  careerClarity: z.number().int().min(0).max(100),
  emotionalWellbeing: z.number().int().min(0).max(100),
})), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'counsellor') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Counsellor access required', 403);
  const { rows: [counsellor] } = await query<any>(
    'SELECT id FROM counsellors WHERE user_id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1',
    [req.auth!.userId, req.auth!.orgId]
  );
  if (!counsellor) throw ApiError.notFound('Counsellor profile not found');
  const { rows: [rating] } = await query<any>(`
    INSERT INTO student_progress_ratings
      (organization_id, student_id, counsellor_id, counsellor_progress, career_clarity, emotional_wellbeing)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (student_id, counsellor_id, rating_month) DO UPDATE SET
      counsellor_progress=EXCLUDED.counsellor_progress,
      career_clarity=EXCLUDED.career_clarity,
      emotional_wellbeing=EXCLUDED.emotional_wellbeing,
      updated_at=NOW()
    RETURNING counsellor_progress AS "counsellorProgress", career_clarity AS "careerClarity",
      emotional_wellbeing AS "emotionalWellbeing", rating_month AS month
  `, [req.auth!.orgId, req.params.id, counsellor.id, req.body.counsellorProgress, req.body.careerClarity, req.body.emotionalWellbeing]);
  res.json(success(rating));
}));

studentPortalRoutes.post('/:id/progress-feedback', validate(z.object({ text: z.string().trim().min(1).max(5000) })), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'counsellor') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Counsellor access required', 403);
  const { rows: [counsellor] } = await query<any>(
    'SELECT id FROM counsellors WHERE user_id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1',
    [req.auth!.userId, req.auth!.orgId]
  );
  if (!counsellor) throw ApiError.notFound('Counsellor profile not found');
  const { rows: [feedback] } = await query<any>(`
    INSERT INTO student_progress_feedback (organization_id, student_id, counsellor_id, feedback_text)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (student_id, counsellor_id, feedback_date)
    DO UPDATE SET feedback_text=EXCLUDED.feedback_text, updated_at=NOW()
    RETURNING id, feedback_text AS text, feedback_date AS date
  `, [req.auth!.orgId, req.params.id, counsellor.id, req.body.text]);
  res.json(success(feedback));
}));

studentPortalRoutes.get('/:id/snapshot', asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  const { rows: actions } = await query<any>(`
    SELECT id, todo_text AS text, is_done AS done, due_date AS due, assigned_by
    FROM todos WHERE student_id=$1 ORDER BY due_date DESC NULLS LAST, id DESC LIMIT 100
  `, [req.params.id]);
  const { rows: [checkin] } = await query<any>(`
    SELECT mood_level AS mood, feeling_text AS reflection, check_in_date AS date
    FROM daily_check_ins WHERE student_id=$1 ORDER BY check_in_date DESC LIMIT 1
  `, [req.params.id]);
  const { rows: marksheets } = await query<any>(`
    SELECT id, file_name AS name, mime_type AS "mimeType", file_size AS size, uploaded_at AS "uploadedAt"
    FROM student_marksheets WHERE student_id=$1 ORDER BY uploaded_at DESC
  `, [req.params.id]);
  const { rows: [counsellorFeedback] } = await query<any>(`
    SELECT f.feedback_text AS text, f.feedback_date AS date, c.full_name AS "counsellorName"
    FROM student_progress_feedback f JOIN counsellors c ON c.id=f.counsellor_id
    WHERE f.student_id=$1 AND f.organization_id=$2
    ORDER BY f.feedback_date DESC, f.updated_at DESC LIMIT 1
  `, [req.params.id, req.auth!.orgId]);
  const { rows: [publishedAdvice] } = await query<any>(`
    SELECT c.session_summary AS "studyImprovement",
      c.observations AS "regularImprovement",
      c.recommendations, c.finalized_at AS "publishedAt",
      co.full_name AS "counsellorName"
    FROM conclusions c
    JOIN inquiries i ON i.id=c.inquiry_id
    JOIN counsellors co ON co.id=c.counsellor_id
    WHERE i.student_id=$1 AND c.organization_id=$2 AND c.is_draft=FALSE
    ORDER BY c.finalized_at DESC NULLS LAST, c.created_at DESC LIMIT 1
  `, [req.params.id, req.auth!.orgId]);
  const { rows: [progressRating] } = await query<any>(`
    SELECT counsellor_progress AS "counsellorProgress",
      career_clarity AS "careerClarity",
      emotional_wellbeing AS "emotionalWellbeing",
      rating_month AS month, updated_at AS "updatedAt"
    FROM student_progress_ratings
    WHERE student_id=$1 AND organization_id=$2
    ORDER BY rating_month DESC, updated_at DESC LIMIT 1
  `, [req.params.id, req.auth!.orgId]);
  const { rows: [parentFeedback] } = await query<any>(`
    SELECT jsonb_build_object(
      'directFeedback', pf.feedback_text,
      'feedbackSubject', pf.feedback_category,
      'directFeedbackAt', pf.submitted_at
    ) || COALESCE(pif.answers, '{}'::jsonb) AS answers,
      pf.submitted_at AS "updatedAt"
    FROM parent_feedback pf
    JOIN parents p ON p.id=pf.parent_id AND p.deleted_at IS NULL
    LEFT JOIN parent_information_forms pif ON pif.parent_id=p.id
    WHERE pf.student_id=$1 AND pf.organization_id=$2
      AND pf.is_visible_to_counsellor=TRUE
    ORDER BY pf.submitted_at DESC LIMIT 1
  `, [req.params.id, req.auth!.orgId]);
  const { rows: [privateNote] } = actor === 'counsellor' ? await query<any>(`
    SELECT note_text AS text, updated_at AS "updatedAt"
    FROM counsellor_student_notes
    WHERE student_id=$1 AND counsellor_id=(
      SELECT id FROM counsellors WHERE user_id=$2 AND organization_id=$3 AND deleted_at IS NULL LIMIT 1
    )
    ORDER BY updated_at DESC LIMIT 1
  `, [req.params.id, req.auth!.userId, req.auth!.orgId]) : { rows: [null] };
  res.json(success({ actions, checkin: checkin || null, marksheets,
    counsellorFeedback: counsellorFeedback || null,
    publishedAdvice: publishedAdvice || null,
    progressRating: progressRating || null,
    parentFeedback: parentFeedback || null,
    privateNote: privateNote || null }));
}));

studentPortalRoutes.post('/:id/counsellor-note', validate(z.object({ text: z.string().trim().min(1).max(5000) })), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'counsellor') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Counsellor access required', 403);
  const { rows: [counsellor] } = await query<any>(
    'SELECT id FROM counsellors WHERE user_id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1',
    [req.auth!.userId, req.auth!.orgId]
  );
  if (!counsellor) throw ApiError.notFound('Counsellor profile not found');
  const { rows: [note] } = await query<any>(`
    INSERT INTO counsellor_student_notes (organization_id, student_id, counsellor_id, note_text)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (student_id, counsellor_id) DO UPDATE SET note_text=EXCLUDED.note_text, updated_at=NOW()
    RETURNING note_text AS text, updated_at AS "updatedAt"
  `, [req.auth!.orgId, req.params.id, counsellor.id, req.body.text]);
  res.json(success(note));
}));

studentPortalRoutes.post('/:id/actions', validate(z.object({ text: z.string().trim().min(1).max(500) })), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  const { rows: [inquiry] } = await query<any>(
    'SELECT id FROM inquiries WHERE student_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', [req.params.id]
  );
  const { rows: [counsellor] } = actor === 'counsellor'
    ? await query<any>('SELECT id FROM counsellors WHERE user_id=$1 AND deleted_at IS NULL LIMIT 1', [req.auth!.userId])
    : { rows: [null] };
  const { rows: [action] } = await query<any>(`
    INSERT INTO todos (organization_id, inquiry_id, student_id, assigned_by, todo_text, is_done, due_date)
    VALUES ($1,$2,$3,$4,$5,FALSE,CURRENT_DATE)
    RETURNING id, todo_text AS text, is_done AS done, due_date AS due, assigned_by
  `, [req.auth!.orgId, inquiry?.id || null, req.params.id, counsellor?.id || null, req.body.text]);
  res.status(201).json(success(action));
}));

studentPortalRoutes.patch('/:id/actions/:actionId', validate(z.object({ done: z.boolean() })), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'student') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Only the student can complete actions', 403);
  const { rows: [action] } = await query<any>(`
    UPDATE todos SET is_done=$1 WHERE id=$2 AND student_id=$3
    RETURNING id, todo_text AS text, is_done AS done, due_date AS due, assigned_by
  `, [req.body.done, req.params.actionId, req.params.id]);
  if (!action) throw ApiError.notFound('Action not found');
  res.json(success(action));
}));

studentPortalRoutes.post('/:id/wellness', validate(z.object({ mood: z.number().int().min(1).max(5), reflection: z.string().max(5000) })), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'student') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Only the student can submit a check-in', 403);
  const { rows: [inquiry] } = await query<any>(
    'SELECT id FROM inquiries WHERE student_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', [req.params.id]
  );
  const { rows: [checkin] } = await query<any>(`
    INSERT INTO daily_check_ins (organization_id, student_id, inquiry_id, check_in_date, mood_level, feeling_text, submitted_at)
    VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,NOW())
    ON CONFLICT (student_id, check_in_date) DO UPDATE SET mood_level=EXCLUDED.mood_level,
      feeling_text=EXCLUDED.feeling_text, submitted_at=NOW()
    RETURNING mood_level AS mood, feeling_text AS reflection, check_in_date AS date
  `, [req.auth!.orgId, req.params.id, inquiry?.id || null, req.body.mood, req.body.reflection]);
  res.json(success(checkin));
}));

studentPortalRoutes.post('/:id/marksheets', raw({ type: 'application/octet-stream', limit: '8mb' }), asyncHandler(async (req, res) => {
  const { actor } = await access(req, String(req.params.id));
  if (actor !== 'student') throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Only the student can upload marksheets', 403);
  const bytes = req.body as Buffer;
  const mimeType = String(req.headers['x-file-type'] || '');
  const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'marksheet')).slice(0, 200);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Upload a PDF, JPG or PNG under 8 MB');
  }
  const id = crypto.randomUUID();
  await query(`INSERT INTO student_marksheets (id, organization_id, student_id, file_name, mime_type, file_size, file_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, req.auth!.orgId, req.params.id, fileName, mimeType, bytes.length, bytes]);
  res.status(201).json(success({ id, name: fileName, mimeType, size: bytes.length, uploadedAt: new Date().toISOString() }));
}));

studentPortalRoutes.get('/:id/marksheets/:fileId', asyncHandler(async (req, res) => {
  await access(req, String(req.params.id));
  const { rows: [file] } = await query<any>(
    'SELECT file_name, mime_type, file_data FROM student_marksheets WHERE id=$1 AND student_id=$2',
    [req.params.fileId, req.params.id]
  );
  if (!file) throw ApiError.notFound('Marksheet not found');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/["\\\r\n]/g, '_')}"`);
  res.send(file.file_data);
}));

studentPortalRoutes.get('/my-profile', asyncHandler(async (req, res) => {
  const { rows: studentRows } = await query<any>(`
    SELECT s.id, s.registration_number, s.full_name, s.email, s.phone,
           s.address_line1, s.address_line2, s.city, s.state, s.pincode,
           s.school_college_name, s.photo_url, s.photo_storage_key,
           u.avatar_url, u.avatar_storage_key
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = $1 AND s.deleted_at IS NULL
    ORDER BY s.created_at DESC LIMIT 1
  `, [req.auth!.userId]);

  if (studentRows.length === 0) {
    const { rows: [u] } = await query<any>(`
      SELECT id, full_name, email, phone, avatar_url, avatar_storage_key 
      FROM users WHERE id = $1
    `, [req.auth!.userId]);
    if (!u) throw ApiError.notFound('User not found');
    return res.json(success({
      studentId: null,
      registrationNumber: null,
      fullName: u.full_name,
      email: u.email,
      phone: u.phone,
      address: '',
      schoolCollegeName: '',
      photoUrl: u.avatar_url || u.avatar_storage_key || null,
      parentConnected: false,
      parent: null,
    }));
  }

  const s = studentRows[0];
  const photoUrl = s.photo_url || s.photo_storage_key || s.avatar_url || s.avatar_storage_key || null;

  const { rows: parentRows } = await query<any>(`
    SELECT p.id, p.full_name, p.phone, p.email, p.relationship_to_student, p.occupation,
           sp.is_guardian, sp.is_primary_contact, sp.can_view_progress
    FROM student_parents sp
    JOIN parents p ON p.id = sp.parent_id
    WHERE sp.student_id = $1 AND p.deleted_at IS NULL
    ORDER BY sp.created_at DESC
    LIMIT 1
  `, [s.id]);

  const parentConnected = parentRows.length > 0;
  const parent = parentConnected ? {
    id: parentRows[0].id,
    fullName: parentRows[0].full_name,
    phone: parentRows[0].phone,
    email: parentRows[0].email,
    relationship: parentRows[0].relationship_to_student,
    occupation: parentRows[0].occupation,
  } : null;

  res.json(success({
    id: s.id,
    studentId: s.registration_number || s.id,
    registrationNumber: s.registration_number,
    fullName: s.full_name,
    email: s.email,
    phone: s.phone,
    address: [s.address_line1, s.address_line2, s.city, s.state, s.pincode].filter(Boolean).join(', ') || s.address_line1 || '',
    addressLine1: s.address_line1 || '',
    schoolCollegeName: s.school_college_name || '',
    photoUrl,
    parentConnected,
    parent,
  }));
}));

const UpdateProfileSchema = z.object({
  photoUrl: z.string().optional(),
  address: z.string().optional(),
  schoolCollegeName: z.string().optional(),
  phone: z.string().optional(),
});

studentPortalRoutes.put('/my-profile', validate(UpdateProfileSchema), asyncHandler(async (req, res) => {
  const { photoUrl, address, schoolCollegeName, phone } = req.body;
  const userId = req.auth!.userId;

  if (photoUrl !== undefined || phone !== undefined) {
    await query(`
      UPDATE users SET
        avatar_storage_key = COALESCE($1, avatar_storage_key),
        avatar_url = COALESCE($1, avatar_url),
        phone = COALESCE($2, phone),
        updated_at = NOW()
      WHERE id = $3
    `, [photoUrl || null, phone || null, userId]);
  }

  await query(`
    UPDATE students SET
      photo_storage_key = COALESCE($1, photo_storage_key),
      photo_url = COALESCE($1, photo_url),
      address_line1 = COALESCE($2, address_line1),
      school_college_name = COALESCE($3, school_college_name),
      phone = COALESCE($4, phone),
      updated_at = NOW()
    WHERE user_id = $5 AND deleted_at IS NULL
  `, [photoUrl || null, address || null, schoolCollegeName || null, phone || null, userId]);

  res.json(success({ ok: true, message: 'Profile updated successfully' }));
}));

