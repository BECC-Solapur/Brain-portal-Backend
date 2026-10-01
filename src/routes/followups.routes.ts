import { Router } from 'express';
export const followupRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';

// GET /api/v1/followups - List all follow-up tasks & records with stats
followupRoutes.get('/', requireAuth(), asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const { status, inquiryId, priority, dateRange, search } = req.query as {
    status?: string;
    inquiryId?: string;
    priority?: string;
    dateRange?: string;
    search?: string;
  };

  let sql = `
    SELECT 
      f.id,
      f.inquiry_id,
      f.followup_date,
      f.remark,
      f.status_code,
      f.conducted_by,
      f.next_followup_date,
      f.created_at,
      f.updated_at,
      i.inquiry_number,
      i.status AS inquiry_status,
      i.fee_status,
      s.full_name AS student_name,
      s.email AS student_email,
      s.phone AS student_phone,
      p.name AS program_name,
      c.full_name AS conducted_by_name
    FROM follow_up_records f
    JOIN inquiries i ON i.id = f.inquiry_id
    JOIN students s ON s.id = i.student_id
    LEFT JOIN programs p ON p.id = i.program_id
    LEFT JOIN counsellors c ON c.id = f.conducted_by
    WHERE i.organization_id = $1
  `;
  const params: any[] = [auth.orgId];
  let pIdx = 2;

  if (inquiryId) {
    sql += ` AND f.inquiry_id = $${pIdx++}`;
    params.push(inquiryId);
  }
  if (status) {
    if (status === 'pending' || status === 'scheduled') {
      sql += ` AND (f.status_code IS NULL OR f.status_code = 'pending' OR f.status_code = 'scheduled')`;
    } else if (status === 'completed') {
      sql += ` AND f.status_code = 'completed'`;
    } else if (status === 'overdue') {
      sql += ` AND (f.status_code IS NULL OR f.status_code = 'pending') AND f.followup_date < CURRENT_DATE`;
    } else {
      sql += ` AND f.status_code = $${pIdx++}`;
      params.push(status);
    }
  }
  if (search) {
    sql += ` AND (s.full_name ILIKE $${pIdx} OR s.phone ILIKE $${pIdx} OR i.inquiry_number ILIKE $${pIdx})`;
    params.push(`%${search}%`);
    pIdx++;
  }

  sql += ` ORDER BY f.followup_date ASC, f.created_at DESC`;

  const { rows } = await query<any>(sql, params);

  // Compute stats
  const { rows: [stats] } = await query<any>(`
    SELECT
      COUNT(*) FILTER (WHERE f.followup_date = CURRENT_DATE AND (f.status_code IS NULL OR f.status_code = 'pending'))::int AS due_today,
      COUNT(*) FILTER (WHERE f.followup_date < CURRENT_DATE AND (f.status_code IS NULL OR f.status_code = 'pending'))::int AS overdue,
      COUNT(*) FILTER (WHERE f.status_code = 'completed' AND f.updated_at >= NOW() - INTERVAL '7 days')::int AS completed_this_week,
      COUNT(*) FILTER (WHERE (f.status_code IS NULL OR f.status_code = 'pending') AND f.followup_date >= CURRENT_DATE AND f.followup_date < CURRENT_DATE + 7)::int AS due_this_week,
      COUNT(*) FILTER (WHERE f.status_code IS NULL OR f.status_code = 'pending')::int AS total_pending,
      (SELECT COUNT(*)::int FROM appointments a
       JOIN inquiries ai ON ai.id = a.inquiry_id
       WHERE ai.organization_id = $1 AND a.appointment_date = CURRENT_DATE + 1
         AND a.status NOT IN ('cancelled', 'completed')) AS tomorrow_sessions
    FROM follow_up_records f
    WHERE f.organization_id = $1
  `, [auth.orgId]);

  const followups = rows.map(r => ({
    id: r.id,
    inquiryId: r.inquiry_id,
    inquiryNumber: r.inquiry_number,
    inquiryStatus: r.inquiry_status,
    studentName: r.student_name,
    studentEmail: r.student_email,
    studentPhone: r.student_phone,
    programName: r.program_name,
    followupDate: r.followup_date,
    remark: r.remark,
    statusCode: r.status_code || 'pending',
    conductedBy: r.conducted_by_name || 'Counsellor',
    nextFollowupDate: r.next_followup_date,
    isOverdue: (!r.status_code || r.status_code === 'pending') && new Date(r.followup_date) < new Date(new Date().toDateString()),
    createdAt: r.created_at,
  }));

  res.json(success({
    followups,
    stats: {
      totalDueToday: (stats?.due_today || 0) + (stats?.tomorrow_sessions || 0),
      tomorrowCounsellingReminders: stats?.tomorrow_sessions || 0,
      weeklyFollowUps: stats?.due_this_week || 0,
      overdue: stats?.overdue || 0,
      completedThisWeek: stats?.completed_this_week || 0,
      pendingFollowUps: stats?.total_pending || 0,
    }
  }));
}));

const CreateFollowUpSchema = z.object({
  inquiryId: z.string().uuid(),
  followupDate: z.string(),
  remark: z.string().optional(),
  statusCode: z.string().default('pending'),
  nextFollowupDate: z.string().optional(),
  conductedBy: z.string().uuid().optional(),
});

// POST /api/v1/followups - Schedule a new follow-up
followupRoutes.post('/', requireAuth(), validate(CreateFollowUpSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;

  let counsellorId = d.conductedBy || null;
  if (!counsellorId) {
    const { rows: cRows } = await query<any>(`SELECT id FROM counsellors WHERE user_id = $1 LIMIT 1`, [auth.userId]);
    counsellorId = cRows[0]?.id;
  }
  if (!counsellorId) {
    const { rows: cAny } = await query<any>(`SELECT id FROM counsellors LIMIT 1`);
    counsellorId = cAny[0]?.id || null;
  }

  const { rows: [record] } = await query<any>(`
    INSERT INTO follow_up_records (
      inquiry_id, followup_date, remark, status_code, conducted_by, next_followup_date
    ) VALUES (
      $1, $2::DATE, $3, $4, $5, $6
    ) RETURNING *
  `, [
    d.inquiryId,
    d.followupDate,
    d.remark || 'Scheduled follow-up',
    d.statusCode,
    counsellorId,
    d.nextFollowupDate ? d.nextFollowupDate : null
  ]);

  res.status(201).json(success(record));
}));

const LogCallSchema = z.object({
  callOutcome: z.string().min(1),
  notes: z.string().min(1),
  nextFollowUpDate: z.string().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  statusCode: z.string().default('completed'),
});

// POST /api/v1/followups/:id/log-call - Log call outcome or interaction
followupRoutes.post('/:id/log-call', requireAuth(), validate(LogCallSchema), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const d = req.body;
  const auth = req.auth!;

  let counsellorId: string | null = null;
  const { rows: cRows } = await query<any>(`SELECT id FROM counsellors WHERE user_id = $1 LIMIT 1`, [auth.userId]);
  counsellorId = cRows[0]?.id;
  if (!counsellorId) {
    const { rows: cAny } = await query<any>(`SELECT id FROM counsellors LIMIT 1`);
    counsellorId = cAny[0]?.id || null;
  }

  const result = await tx(async (client) => {
    const { rows: [existing] } = await client.query<any>(
      `SELECT * FROM follow_up_records WHERE id = $1`,
      [id]
    );
    if (!existing) throw ApiError.notFound('Follow-up record not found');

    const formattedRemark = `${d.callOutcome}: ${d.notes}${d.durationSeconds ? ` (${Math.round(d.durationSeconds / 60)} mins)` : ''}`;

    const { rows: [updated] } = await client.query<any>(`
      UPDATE follow_up_records
      SET remark = CASE WHEN remark IS NULL THEN $1 ELSE remark || E'\n' || $1 END,
          status_code = $2,
          conducted_by = COALESCE($3, conducted_by),
          next_followup_date = $4,
          updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [
      formattedRemark,
      d.statusCode,
      counsellorId,
      d.nextFollowUpDate ? d.nextFollowUpDate : null,
      id
    ]);

    // If next follow-up date provided, optionally create another pending follow-up record
    if (d.nextFollowUpDate) {
      await client.query(`
        INSERT INTO follow_up_records (
          inquiry_id, followup_date, remark, status_code, conducted_by
        ) VALUES (
          $1, $2::DATE, $3, 'pending', $4
        )
      `, [
        existing.inquiry_id,
        d.nextFollowUpDate,
        `Next action after: ${d.callOutcome}`,
        counsellorId
      ]);
    }

    return updated;
  });

  res.json(success(result));
}));

// PATCH /api/v1/followups/:id/complete - Mark follow-up as completed
followupRoutes.patch('/:id/complete', requireAuth(), asyncHandler(async (req, res) => {
  const id = req.params.id;

  const { rows: [updated] } = await query<any>(`
    UPDATE follow_up_records
    SET status_code = 'completed',
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [id]);

  if (!updated) throw ApiError.notFound('Follow-up record not found');

  res.json(success(updated));
}));
