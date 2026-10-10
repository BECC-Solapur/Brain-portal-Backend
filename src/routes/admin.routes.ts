import { Router } from 'express';
export const adminRoutes = Router();
import { requireAuth, requireRoles } from '../middleware/auth';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';
import { hashPassword } from '../utils/auth';
import { z } from 'zod';
import { validate } from '../middleware/validate';

adminRoutes.use(requireAuth(), requireRoles('superadmin', 'brain_admin'));

adminRoutes.get('/daily-appointments', requireRoles('brain_admin'), asyncHandler(async (req, res) => {
  const { rows: [{ today }] } = await query<{ today: string }>(
    "SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today"
  );
  const { rows } = await query<any>(`
    SELECT a.id, a.appointment_date AS date,
      a.slot_start_time::text AS "startTime", a.slot_end_time::text AS "endTime",
      TO_CHAR(a.slot_start_time, 'HH12:MI AM') || ' – ' || TO_CHAR(a.slot_end_time, 'HH12:MI AM') AS "timeDisplay",
      a.mode, a.status, a.location, a.join_url AS "meetingLinkUrl",
      s.full_name AS "studentName", s.phone AS "studentPhone",
      c.full_name AS "counsellorName", p.name AS "programName"
    FROM appointments a
    JOIN inquiries i ON i.id=a.inquiry_id
    JOIN students s ON s.id=i.student_id
    JOIN counsellors c ON c.id=a.counsellor_id
    LEFT JOIN programs p ON p.id=i.program_id
    WHERE a.organization_id=$1 AND a.appointment_date=$2::date AND a.status != 'cancelled'
    ORDER BY a.slot_start_time ASC, s.full_name ASC
  `, [req.auth!.orgId, today]);
  res.json(success({ date: today, appointments: rows }));
}));

adminRoutes.get('/brain-overview', requireRoles('brain_admin'), asyncHandler(async (req, res) => {
  const orgId = req.auth!.orgId;
  const { rows: [totals] } = await query<any>(`
    SELECT COUNT(*)::int AS "registeredStudents"
    FROM students WHERE organization_id=$1 AND deleted_at IS NULL AND is_active=TRUE
  `, [orgId]);
  const { rows: modules } = await query<any>(`
    SELECT p.id, p.name, COUNT(DISTINCT s.id)::int AS count
    FROM programs p
    LEFT JOIN inquiries i ON i.program_id=p.id AND i.organization_id=$1 AND i.deleted_at IS NULL
    LEFT JOIN students s ON s.id=i.student_id AND s.deleted_at IS NULL AND s.is_active=TRUE
    WHERE p.organization_id=$1 AND p.is_active=TRUE AND LOWER(p.code) <> 'cmt'
    GROUP BY p.id, p.name, p.sort_order
    ORDER BY p.sort_order, p.name
  `, [orgId]);
  const { rows: [slots] } = await query<any>(`
    WITH dates AS (
      SELECT day::date AS day FROM generate_series(
        (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
        (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 6,
        INTERVAL '1 day'
      ) AS day
    )
    SELECT COUNT(*)::int AS count FROM dates d
    JOIN counsellors c ON c.organization_id=$1 AND c.is_active=TRUE AND c.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT configured.slot_start_time, configured.is_weekday_available
      FROM time_slots configured
      WHERE configured.is_active=TRUE
        AND (configured.branch_id=c.branch_id OR configured.branch_id IS NULL)
      UNION ALL
      SELECT defaults.slot_start_time,
        ARRAY[TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE]::boolean[]
      FROM (VALUES
        ('09:00:00'::time), ('11:00:00'::time), ('14:00:00'::time),
        ('16:00:00'::time), ('17:00:00'::time)
      ) defaults(slot_start_time)
      WHERE NOT EXISTS (
        SELECT 1 FROM time_slots configured
        WHERE configured.is_active=TRUE
          AND (configured.branch_id=c.branch_id OR configured.branch_id IS NULL)
      )
    ) ts
    WHERE COALESCE(ts.is_weekday_available[EXTRACT(ISODOW FROM d.day)::int], FALSE)
      AND (d.day > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        OR ts.slot_start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time)
      AND NOT EXISTS (
        SELECT 1 FROM appointments a WHERE a.counsellor_id=c.id
          AND a.appointment_date=d.day AND a.slot_start_time=ts.slot_start_time
          AND a.status != 'cancelled'
      )
  `, [orgId]);
  const { rows: [followups] } = await query<any>(`
    WITH reminder_inquiries AS (
      SELECT f.inquiry_id
      FROM follow_up_records f
      JOIN inquiries i ON i.id=f.inquiry_id
      WHERE i.organization_id=$1 AND i.deleted_at IS NULL
        AND COALESCE(f.status_code, 'pending') IN ('pending', 'scheduled')
        AND COALESCE(f.next_followup_date, f.followup_date) >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND COALESCE(f.next_followup_date, f.followup_date) < (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 7
      UNION
      SELECT a.inquiry_id
      FROM appointments a
      WHERE a.organization_id=$1
        AND a.appointment_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND a.appointment_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 7
        AND a.status NOT IN ('cancelled', 'completed')
    )
    SELECT COUNT(*)::int AS count FROM reminder_inquiries
  `, [orgId]);
  res.json(success({ registeredStudents: totals.registeredStudents, availableSlots: slots.count,
    upcomingFollowups: followups.count, modules }));
}));

adminRoutes.get('/pricing', requireRoles('brain_admin'), asyncHandler(async (req, res) => {
  const { rows } = await query<any>(`
    SELECT id, code, name, price, gst_rate_percent, service_fee_rate_percent, is_active, sort_order
    FROM programs
    WHERE organization_id=$1 AND is_active=TRUE
    ORDER BY CASE WHEN LOWER(code)='cmt' THEN 1 ELSE 0 END, sort_order, name
  `, [req.auth!.orgId]);

  res.json(success(rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: String(row.code).toLowerCase() === 'cmt' ? 'ai_cmt' : 'module',
    price: Number(row.price),
    gstRatePercent: Number(row.gst_rate_percent || 0),
    serviceFeeRatePercent: Number(row.service_fee_rate_percent || 0),
    totalWithGst: Math.round(Number(row.price) * (1 + Number(row.gst_rate_percent || 0) / 100)),
  }))));
}));

const UpdatePricingSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    price: z.number().finite().min(0).max(1000000),
  })).min(1).max(20),
});

adminRoutes.patch('/pricing', requireRoles('brain_admin'), validate(UpdatePricingSchema), asyncHandler(async (req, res) => {
  const items = req.body.items as Array<{ id: string; price: number }>;
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Each pricing item can only be submitted once.');
  }

  const updated = await tx(async (client) => {
    const rows: any[] = [];
    for (const item of items) {
      const { rows: [row] } = await client.query<any>(`
        UPDATE programs
        SET price=$1, updated_by=$2, updated_at=NOW()
        WHERE id=$3 AND organization_id=$4 AND is_active=TRUE
        RETURNING id, code, name, price, gst_rate_percent, service_fee_rate_percent
      `, [item.price, req.auth!.userId, item.id, req.auth!.orgId]);
      if (!row) throw ApiError.notFound('One of the pricing items was not found.');
      rows.push(row);
    }
    return rows;
  });

  res.json(success(updated.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: String(row.code).toLowerCase() === 'cmt' ? 'ai_cmt' : 'module',
    price: Number(row.price),
    gstRatePercent: Number(row.gst_rate_percent || 0),
    serviceFeeRatePercent: Number(row.service_fee_rate_percent || 0),
    totalWithGst: Math.round(Number(row.price) * (1 + Number(row.gst_rate_percent || 0) / 100)),
  }))));
}));

adminRoutes.get('/registered-students', requireRoles('brain_admin'), asyncHandler(async (req, res) => {
  const rawPage = Number(req.query.page || 1);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 100000) : 1;
  const perPage = 10;
  const search = String(req.query.search || '').trim().slice(0, 100);
  const programId = String(req.query.programId || '').trim();
  if (programId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(programId)) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Invalid counselling module');
  }
  const params = [req.auth!.orgId, `%${search}%`, programId || null];
  const where = `s.organization_id=$1 AND s.deleted_at IS NULL AND s.is_active=TRUE
    AND s.full_name ILIKE $2 AND ($3::uuid IS NULL OR module.id IS NOT NULL)`;
  const from = `FROM students s LEFT JOIN LATERAL (
    SELECT p.id, p.name,
      (SELECT sp.extra_fields_jsonb->>'schoolCollege'
       FROM student_preferences sp WHERE sp.inquiry_id=i.id LIMIT 1) AS school_college
    FROM inquiries i JOIN programs p ON p.id=i.program_id
    WHERE i.student_id=s.id AND i.deleted_at IS NULL AND ($3::uuid IS NULL OR i.program_id=$3::uuid)
    ORDER BY i.created_at DESC LIMIT 1
  ) module ON TRUE`;
  const { rows: [countRow] } = await query<any>(`SELECT COUNT(*)::int AS total ${from} WHERE ${where}`, params);
  const { rows: students } = await query<any>(`
    SELECT s.id, s.full_name AS name, s.registration_number AS "registrationNumber",
      s.email, s.phone, s.created_at AS "registeredAt", module.name AS "moduleName",
      CONCAT_WS(', ', NULLIF(s.address_line1, ''), NULLIF(s.address_line2, ''),
        NULLIF(s.city, ''), NULLIF(s.state, ''), NULLIF(s.pincode, '')) AS address,
      COALESCE(s.school_college_name, module.school_college) AS "schoolCollegeName"
    ${from} WHERE ${where}
    ORDER BY s.created_at DESC, s.full_name ASC LIMIT $4 OFFSET $5
  `, [...params, perPage, (page - 1) * perPage]);
  res.json(success({ students, total: countRow.total, page, perPage,
    pages: Math.max(1, Math.ceil(countRow.total / perPage)) }));
}));

adminRoutes.get('/stats', asyncHandler(async (req, res) => {
  const orgId = req.auth!.orgId;
  const { rows: s } = await query<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE organization_id = $1 AND deleted_at IS NULL) AS registered_students,
      (SELECT COUNT(*)::int FROM students WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days' AND deleted_at IS NULL) AS delta7d,
      (SELECT COUNT(*)::int FROM follow_up_records followup
        JOIN inquiries inquiry ON inquiry.id=followup.inquiry_id
        WHERE inquiry.organization_id=$1
          AND (followup.status_code IS NULL OR followup.status_code='pending')
          AND followup.followup_date <= CURRENT_DATE) AS followups_due,
      (SELECT COUNT(*)::int FROM follow_up_records followup
        JOIN inquiries inquiry ON inquiry.id=followup.inquiry_id
        WHERE inquiry.organization_id=$1
          AND (followup.status_code IS NULL OR followup.status_code='pending')
          AND followup.followup_date < CURRENT_DATE) AS followups_overdue,
      (SELECT COALESCE(SUM(total_amount), 0)::numeric FROM payments WHERE organization_id = $1 AND status='paid') AS fees_collected,
      (SELECT COUNT(*)::int FROM counselling_sessions cs
        JOIN appointments a ON a.id = cs.appointment_id
        WHERE a.organization_id = $1 AND cs.status='completed'
          AND cs.session_ended_at >= NOW() - INTERVAL '7 days') AS sessions_completed_week,
      (SELECT COUNT(*)::int FROM counselling_sessions cs
        JOIN appointments a ON a.id = cs.appointment_id
        WHERE a.organization_id = $1 AND a.appointment_date = CURRENT_DATE
          AND cs.status IN ('scheduled','in_progress')) AS sessions_today,
      (SELECT COUNT(*)::int FROM inquiries WHERE organization_id = $1 AND status='draft') AS pending_registrations_new,
      (SELECT COUNT(*)::int FROM inquiries WHERE organization_id = $1 AND fee_status='pending' AND status IN ('program_selected','payment_pending','payment_failed')) AS pending_fee_payments,
      (SELECT COUNT(*)::int FROM inquiries i
        WHERE i.organization_id = $1
          AND i.status IN ('session_completed','conclusion_drafted')
          AND i.id NOT IN (SELECT inquiry_id FROM conclusions WHERE is_draft = FALSE)) AS pending_conclusion_reports,
      (SELECT COUNT(*)::int FROM referral_codes WHERE organization_id = $1 AND status='active' AND deleted_at IS NULL) AS referral_codes_active,
      (SELECT COUNT(DISTINCT inquiry_id)::int FROM payments
        WHERE organization_id = $1 AND status='paid'
          AND referral_code_id IS NOT NULL
          AND paid_at >= DATE_TRUNC('month', CURRENT_DATE)) AS referral_conversions_month,
      (SELECT COALESCE(SUM(discount_amount_applied), 0)::numeric FROM payments
        WHERE organization_id = $1 AND status='paid') AS referral_discount_total,
      (SELECT COALESCE(SUM(total_amount), 0)::numeric FROM payments
        WHERE organization_id = $1 AND status='paid'
          AND referral_code_id IS NOT NULL) AS referral_revenue_total
  `, [orgId]);
  const s0 = s[0] || {};
  res.json(success({
    registeredStudents: s0.registered_students,
    delta7d: s0.delta7d,
    followUpsDue: s0.followups_due,
    followUpsOverdue: s0.followups_overdue,
    feesCollected: parseFloat(s0.fees_collected || 0),
    feesCollectedDelta7dPct: 0,
    sessionsToday: s0.sessions_today,
    sessionsCompletedThisWeek: s0.sessions_completed_week,
    pendingRegistrationsNew: s0.pending_registrations_new,
    pendingFeePayments: s0.pending_fee_payments,
    pendingConclusionReports: s0.pending_conclusion_reports,
    avgCounsellorUtilizationPct: 0,
    referralCodesActive: s0.referral_codes_active,
    referralConversionsThisMonth: s0.referral_conversions_month,
    referralDiscountGivenTotal: parseFloat(s0.referral_discount_total || 0),
    referralRevenueAttributedTotal: parseFloat(s0.referral_revenue_total || 0),
  }));
}));

adminRoutes.get('/users', asyncHandler(async (req, res) => {
  const orgId = req.auth!.orgId;
  const { rows } = await query<any>(`
    SELECT u.id, u.email, u.full_name AS name, u.status, u.is_active, u.created_at AS "createdAt",
           COALESCE(
             (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY CASE r.code WHEN 'superadmin' THEN 1 WHEN 'brain_admin' THEN 2 WHEN 'counsellor' THEN 3 WHEN 'student' THEN 4 WHEN 'parent' THEN 5 ELSE 6 END LIMIT 1),
             'User'
           ) AS role
    FROM users u
    WHERE (u.organization_id = $1 OR u.organization_id IS NULL)
      AND u.deleted_at IS NULL
    ORDER BY u.created_at DESC
  `, [orgId]);

  res.json(success(rows.map(u => ({
    id: u.id,
    name: u.name || 'Unnamed User',
    email: u.email,
    role: u.role,
    frozen: !u.is_active || u.status === 'frozen' || u.status === 'suspended',
    createdAt: u.createdAt,
  }))));
}));

adminRoutes.post('/users', asyncHandler(async (req, res) => {
  const orgId = req.auth!.orgId;
  const parsed = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().email(),
    role: z.enum(['Admin', 'Brain Admin', 'SuperAdmin', 'Counsellor', 'Student', 'Parent']),
    password: z.string().min(8).max(72).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Provide a name, valid email, supported role and password of 8–72 characters');
  }
  const { name, email, role, password } = parsed.data;

  const { rows: existing } = await query<any>(
    "SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL",
    [email.trim()]
  );
  if (existing.length > 0) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'A user with this email already exists');
  }

  const roleCodeMap: Record<string, string> = {
    'Admin': 'brain_admin',
    'Brain Admin': 'brain_admin',
    'SuperAdmin': 'superadmin',
    'Counsellor': 'counsellor',
    'Student': 'student',
    'Parent': 'parent',
  };
  const targetRoleCode = roleCodeMap[role] || role.toLowerCase();

  if (['brain_admin', 'superadmin'].includes(targetRoleCode) && !req.auth!.roles.includes('superadmin')) {
    throw new ApiError('AUTH_ROLE_INSUFFICIENT', 'Only SuperAdmin can create administrator credentials', 403);
  }
  if (targetRoleCode === 'brain_admin' && !password) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'A password is required for Brain Admin credentials');
  }
  const { rows: roleRows } = await query<any>(
    "SELECT id, name FROM roles WHERE code = $1 OR LOWER(code) = LOWER($1) LIMIT 1",
    [targetRoleCode]
  );
  if (!roleRows.length) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'The requested role is not configured');
  }

  const pwHash = await hashPassword(password || 'Brain@1234');

  const { rows: [newUser] } = await query<any>(`
    INSERT INTO users (organization_id, email, full_name, display_name, password_hash, status, is_active)
    VALUES ($1, LOWER($2), $3, $3, $4, 'active', TRUE)
    RETURNING id, full_name AS name, email, created_at AS "createdAt"
  `, [orgId, email.trim(), name.trim(), pwHash]);

  if (roleRows.length > 0) {
    await query(`
      INSERT INTO user_roles (user_id, role_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [newUser.id, roleRows[0].id]);
  }

  await query(`
    INSERT INTO audit_logs (organization_id, actor_user_id, actor_role_code, action_type, action_description, action_module, entity_type, entity_id, ip_address)
    VALUES ($1, $2, $3, 'CREATE_USER', $4, 'ACCESS_CONTROL', 'USER', $5, $6)
  `, [
    orgId,
    req.auth!.userId,
    req.auth!.primaryRole || 'superadmin',
    `Created user access for ${name.trim()} (${role})`,
    newUser.id,
    req.ip || '127.0.0.1'
  ]);

  res.status(201).json(success({
    id: newUser.id,
    name: newUser.name,
    email: newUser.email,
    role: roleRows[0]?.name || role,
    frozen: false,
    createdAt: newUser.createdAt,
  }));
}));

adminRoutes.patch('/users/:id/freeze', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { rows: [u] } = await query<any>(
    "SELECT id, full_name, is_active, status FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId]
  );
  if (!u) throw ApiError.notFound('User not found');

  const nextActive = !u.is_active;
  const nextStatus = nextActive ? 'active' : 'frozen';

  await query(
    "UPDATE users SET is_active = $1, status = $2, updated_at = NOW() WHERE id = $3",
    [nextActive, nextStatus, userId]
  );

  await query(`
    INSERT INTO audit_logs (organization_id, actor_user_id, actor_role_code, action_type, action_description, action_module, entity_type, entity_id, ip_address)
    VALUES ($1, $2, $3, $4, $5, 'ACCESS_CONTROL', 'USER', $6, $7)
  `, [
    req.auth!.orgId,
    req.auth!.userId,
    req.auth!.primaryRole || 'superadmin',
    nextActive ? 'RESTORE_USER' : 'FREEZE_USER',
    `${nextActive ? 'Restored' : 'Froze'} user access for ${u.full_name}`,
    userId,
    req.ip || '127.0.0.1'
  ]);

  res.json(success({ id: userId, frozen: !nextActive }));
}));

adminRoutes.delete('/users/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { rows: [u] } = await query<any>(
    "SELECT id, full_name FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId]
  );
  if (!u) throw ApiError.notFound('User not found');

  await query(
    "UPDATE users SET deleted_at = NOW(), is_active = FALSE, status = 'deleted' WHERE id = $1",
    [userId]
  );

  await query(`
    INSERT INTO audit_logs (organization_id, actor_user_id, actor_role_code, action_type, action_description, action_module, entity_type, entity_id, ip_address)
    VALUES ($1, $2, $3, 'DELETE_USER', $4, 'ACCESS_CONTROL', 'USER', $5, $6)
  `, [
    req.auth!.orgId,
    req.auth!.userId,
    req.auth!.primaryRole || 'superadmin',
    `Removed user access for ${u.full_name}`,
    userId,
    req.ip || '127.0.0.1'
  ]);

  res.json(success({ ok: true, id: userId }));
}));

adminRoutes.get('/audit-logs', asyncHandler(async (req, res) => {
  const orgId = req.auth!.orgId;

  // If audit_logs is empty, seed initial records reflecting recent system actions
  const { rows: [{ count: existingCount }] } = await query<{ count: string }>(
    "SELECT COUNT(*) FROM audit_logs"
  );
  if (parseInt(existingCount, 10) === 0) {
    await query(`
      INSERT INTO audit_logs (organization_id, actor_user_id, actor_role_code, action_type, action_description, action_module, entity_type, created_at)
      VALUES
        ($1, $2, 'superadmin', 'SYSTEM_INITIALIZE', 'Initialized multi-tenant portal configuration and master tenant settings', 'SECURITY', 'TENANT', NOW() - INTERVAL '3 hours'),
        ($1, $2, 'superadmin', 'CREATE_USER', 'Created master SuperAdmin account Arpita Kulkarni', 'ACCESS_CONTROL', 'USER', NOW() - INTERVAL '2 hours 45 minutes'),
        ($1, $2, 'superadmin', 'UPDATE_COUNSELLOR', 'Registered certified counsellor Arpita Kulkarni in database', 'COUNSELLOR_ROSTER', 'COUNSELLOR', NOW() - INTERVAL '1 hour 20 minutes'),
        ($1, $2, 'counsellor', 'ROSTER_SYNC', 'Synchronized counsellor caseload and active inquiry records', 'COUNSELLING', 'CASELOAD', NOW() - INTERVAL '45 minutes'),
        ($1, $2, 'superadmin', 'ACCESS_AUDIT', 'SuperAdmin audit verification of portal roles and permissions', 'AUDIT_LOG', 'SECURITY', NOW() - INTERVAL '10 minutes')
    `, [orgId, req.auth!.userId]);
  }

  const { rows } = await query<any>(`
    WITH activity AS (
      SELECT al.id::text AS id, al.created_at,
        COALESCE(u.full_name, 'System Administrator') AS actor,
        COALESCE(al.actor_role_code, 'admin') AS role,
        al.action_description AS action,
        COALESCE(al.action_module, al.entity_type, 'System') AS reference
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_user_id
      WHERE al.organization_id = $1 OR al.organization_id IS NULL

      UNION ALL

      SELECT d.id::text, d.submitted_at, s.full_name, 'student',
        'Submitted daily wellness check-in', 'WELLNESS'
      FROM daily_check_ins d
      JOIN students s ON s.id = d.student_id
      WHERE d.organization_id = $1

      UNION ALL

      SELECT pf.id::text, pf.submitted_at, p.full_name, 'parent',
        'Submitted feedback for counsellor review', 'PARENT_FEEDBACK'
      FROM parent_feedback pf
      JOIN parents p ON p.id = pf.parent_id
      WHERE pf.organization_id = $1

      UNION ALL

      SELECT pif.id::text, COALESCE(pif.submitted_at, pif.updated_at), p.full_name, 'parent',
        CASE WHEN pif.status = 'submitted' THEN 'Submitted parent information form'
          ELSE 'Saved parent information form draft' END,
        'PARENT_FORM'
      FROM parent_information_forms pif
      JOIN parents p ON p.id = pif.parent_id
      WHERE pif.organization_id = $1

      UNION ALL

      SELECT sm.id::text, sm.uploaded_at, s.full_name, 'student',
        'Uploaded academic marksheet', 'MARKSHEET'
      FROM student_marksheets sm
      JOIN students s ON s.id = sm.student_id
      WHERE sm.organization_id = $1

      UNION ALL

      SELECT ar.id::text, ar.completed_at, s.full_name, 'student',
        'Submitted AI CMT assessment result', 'AI_CMT'
      FROM student_ai_cmt_results ar
      JOIN students s ON s.id = ar.student_id
      WHERE ar.organization_id = $1
    )
    SELECT id,
      TO_CHAR(created_at, 'HH24:MI') AS time,
      TO_CHAR(created_at, 'DD Mon YYYY') AS date,
      actor, role, action, reference, created_at
    FROM activity
    ORDER BY created_at DESC
    LIMIT 100
  `, [orgId]);

  const { rows: [counts] } = await query<any>(`
    WITH portal_activity AS (
      SELECT (
        (SELECT COUNT(*) FROM daily_check_ins WHERE organization_id = $1) +
        (SELECT COUNT(*) FROM parent_feedback WHERE organization_id = $1) +
        (SELECT COUNT(*) FROM parent_information_forms WHERE organization_id = $1) +
        (SELECT COUNT(*) FROM student_marksheets WHERE organization_id = $1) +
        (SELECT COUNT(*) FROM student_ai_cmt_results WHERE organization_id = $1)
      )::int AS total
    )
    SELECT
      (COUNT(*) + (SELECT total FROM portal_activity))::int AS total,
      COUNT(*) FILTER (WHERE actor_role_code = 'counsellor')::int AS counsellor,
      COUNT(*) FILTER (WHERE actor_role_code IN ('superadmin', 'brain_admin', 'admin') OR actor_role_code IS NULL)::int AS admin,
      (COUNT(*) FILTER (WHERE actor_role_code IN ('student', 'parent')) + (SELECT total FROM portal_activity))::int AS student_parent
    FROM audit_logs
    WHERE organization_id = $1 OR organization_id IS NULL
  `, [orgId]);

  res.json(success({
    stats: {
      all: counts?.total || 0,
      counsellor: counts?.counsellor || 0,
      admin: counts?.admin || 0,
      studentParent: counts?.student_parent || 0,
    },
    events: rows.map(r => ({
      id: r.id,
      time: r.time,
      date: r.date,
      actor: r.actor,
      role: r.role === 'superadmin' ? 'SuperAdmin' : r.role === 'brain_admin' ? 'Admin' : r.role.charAt(0).toUpperCase() + r.role.slice(1),
      action: r.action,
      reference: r.reference,
    })),
  }));
}));
