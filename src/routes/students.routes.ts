import { Router } from 'express';
export const studentRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query } from '../config/db';

studentRoutes.use(requireAuth());

studentRoutes.get('/:id/history', asyncHandler(async (req, res) => {
  const studentId = req.params.id;
  const auth = req.auth!;
  const { rows: [student] } = await query<any>(`
    SELECT id FROM students
    WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
  `, [studentId, auth.orgId]);
  if (!student) throw ApiError.notFound('Student not found');

  const [{ rows: counsellingHistory }, { rows: billingHistory }] = await Promise.all([
    query<any>(`
      SELECT a.id, a.appointment_date, a.slot_time_display, a.mode, a.status,
             a.location, a.join_url AS meeting_link_url, c.full_name AS counsellor_name,
             cs.session_started_at, cs.session_ended_at, cs.counsellor_notes
      FROM appointments a
      JOIN inquiries i ON i.id = a.inquiry_id
      JOIN counsellors c ON c.id = a.counsellor_id
      LEFT JOIN counselling_sessions cs ON cs.appointment_id = a.id
      WHERE i.student_id = $1
      ORDER BY a.appointment_date DESC, a.slot_start_time DESC
    `, [studentId]),
    query<any>(`
      SELECT p.id, p.receipt_number, p.status, p.method, p.total_amount,
             p.currency, p.razorpay_payment_id, p.paid_at, p.created_at,
             pr.name AS program_name
      FROM payments p
      LEFT JOIN inquiries i ON i.id = p.inquiry_id
      LEFT JOIN programs pr ON pr.id = i.program_id
      WHERE p.student_id = $1
      ORDER BY p.created_at DESC
    `, [studentId]),
  ]);

  res.json(success({ counsellingHistory, billingHistory }));
}));

studentRoutes.get('/:id/dashboard', asyncHandler(async (req, res) => {
  const studentId = req.params.id;
  const { rows: [stu] } = await query<any>(`
    SELECT * FROM students WHERE id = $1 AND deleted_at IS NULL
  `, [studentId]);
  if (!stu) throw ApiError.notFound('Student not found');

  const { rows: inqs } = await query<any>(`
    SELECT i.*, p.code, p.name, p.price, p.tagline, p.grade_range, p.description,
           p.gradient_classes, p.icon_name
    FROM inquiries i
    LEFT JOIN programs p ON p.id = i.program_id
    WHERE i.student_id = $1 AND i.deleted_at IS NULL
    ORDER BY i.created_at DESC LIMIT 1
  `, [studentId]);
  const i = inqs[0] || null;

  const { rows: todos } = await query<any>(`
    SELECT id, todo_text, due_date, is_done
    FROM todos WHERE student_id = $1
    ORDER BY COALESCE(due_date, '9999-12-31') LIMIT 10
  `, [studentId]);

  const latestSessionSql = i ? `
    SELECT cs.id, cs.status, cs.session_started_at, cs.session_ended_at, cs.duration_seconds,
           cs.counsellor_notes, a.mode, a.join_url AS meeting_link_url, a.location
    FROM counselling_sessions cs
    JOIN appointments a ON a.id = cs.appointment_id
    WHERE a.id IN (SELECT id FROM appointments WHERE inquiry_id = $1)
    ORDER BY COALESCE(cs.session_started_at, cs.created_at) DESC NULLS LAST LIMIT 1
  ` : null;
  const latestSession = i ? (await query<any>(latestSessionSql!, [i.id])).rows[0] : null;

  const total = todos.length;
  const done = todos.filter(t => t.is_done).length;
  const pending = total - done;
  const { rows: checks } = await query<any>(`
    SELECT COUNT(*)::int AS n FROM daily_check_ins WHERE student_id = $1
  `, [studentId]);

  res.json(success({
    student: {
      id: stu.id, fullName: stu.full_name, email: stu.email, phone: stu.phone,
      gender: stu.gender, dob: stu.date_of_birth, registrationNumber: stu.registration_number,
      photoStorageKey: stu.photo_storage_key,
    },
    activeInquiry: i ? {
      id: i.id, inquiryNumber: i.inquiry_number, status: i.status, feeStatus: i.fee_status,
      overallProgressPercent: parseInt(i.overall_progress_percent || 0),
      programSnapshot: i.code ? {
        id: i.program_id, code: i.code, name: i.name, tagline: i.tagline,
        gradeRange: i.grade_range, description: i.description, features: [],
        price: parseFloat(i.price || 0), currency: 'INR',
        gradientCssClasses: i.gradient_classes || '', iconName: i.icon_name || '',
        isActive: true,
      } : null,
      activeAppointment: null,
      latestSession: latestSession ? {
        id: latestSession.id, status: latestSession.status,
        startedAt: latestSession.session_started_at, endedAt: latestSession.session_ended_at,
        durationSeconds: latestSession.duration_seconds,
      } : null,
    } : null,
    counters: {
      totalTodos: total, completedTodos: done, pendingTodos: pending,
      totalCheckinsSubmitted: checks[0]?.n || 0, currentStreakDays: 0,
    },
    pendingTodos: todos.filter(t => !t.is_done).slice(0, 5).map(t => ({
      id: t.id, todoText: t.todo_text, dueDate: t.due_date,
    })),
    upcomingSession: null,
    latestConclusionSummary: null,
    progressMilestones: [],
    referralUsed: null,
  }));
}));

const CheckinSchema = z.object({
  moodLevel: z.number().int().min(1).max(5),
  moodEmoji: z.string().optional(),
  whatWentWell: z.string().optional(),
  whatWasHard: z.string().optional(),
  freeTextJournal: z.string().optional(),
  sharedWithCounsellor: z.boolean().default(true),
});
studentRoutes.post('/:id/checkin', validate(CheckinSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const notesParts = [
    d.whatWentWell ? `Well: ${d.whatWentWell}` : null,
    d.whatWasHard ? `Hard: ${d.whatWasHard}` : null,
    d.freeTextJournal ? d.freeTextJournal : null,
  ].filter(Boolean);
  const notes = notesParts.join(' | ');

  const { rows: studentLookup } = await query<any>(
    `SELECT organization_id, (SELECT id FROM inquiries WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1) AS inq_id FROM students WHERE id=$1`,
    [req.params.id]
  );
  const orgId = studentLookup[0]?.organization_id || req.auth!.orgId;
  const inqId = studentLookup[0]?.inq_id || null;

  const { rows: ins } = await query<any>(`
    INSERT INTO daily_check_ins (
      student_id, inquiry_id, check_in_date, mood_level, notes_for_the_day, recorded_at
    ) VALUES ($1, $2, CURRENT_DATE, $3, $4, NOW())
    ON CONFLICT (student_id, check_in_date) DO UPDATE SET
      mood_level = EXCLUDED.mood_level,
      notes_for_the_day = COALESCE(NULLIF(EXCLUDED.notes_for_the_day, ''), daily_check_ins.notes_for_the_day),
      recorded_at = NOW()
    RETURNING id, check_in_date, mood_level
  `, [req.params.id, inqId, d.moodLevel, notes || (d.moodEmoji || null)]);
  res.status(ins.length && ins[0].id && req.method === 'POST' ? 201 : 200).json(success({
    id: ins[0].id,
    date: ins[0].check_in_date,
    moodLevel: ins[0].mood_level,
  }));
}));

studentRoutes.get('/:id/progress', asyncHandler(async (req, res) => {
  const { rows } = await query<any>(`
    SELECT milestone_week_label, recorded_at, progress_percent, notes
    FROM progress_milestones
    WHERE inquiry_id IN (SELECT id FROM inquiries WHERE student_id=$1)
    ORDER BY recorded_at
    LIMIT 24
  `, [req.params.id]);
  res.json(success({
    weeks: rows.map((r, idx) => ({
      weekNo: idx + 1,
      weekLabel: r.milestone_week_label,
      recordedAt: r.recorded_at,
      progressPercent: parseInt(r.progress_percent || 0), note: r.notes,
    })),
  }));
}));
