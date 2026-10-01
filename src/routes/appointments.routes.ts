import { Router } from 'express';
export const appointmentRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';

import { hashPassword } from '../utils/auth';

appointmentRoutes.get('/', asyncHandler(async (_req, res) => {
  const { rows } = await query<any>(`
    SELECT c.id, c.user_id, c.full_name, c.title, c.specializations,
           c.branch_id, b.code AS branch_code, c.is_active, c.deleted_at,
           c.email, c.phone, c.qualifications, c.bio, c.created_at
    FROM counsellors c
    LEFT JOIN branches b ON b.id = c.branch_id
    WHERE c.deleted_at IS NULL AND c.is_active = TRUE
    ORDER BY c.created_at DESC, c.full_name ASC
  `);
  res.json(success(rows.map(c => ({
    id: c.id,
    userId: c.user_id,
    fullName: c.full_name,
    title: c.title || 'Counsellor',
    specializations: Array.isArray(c.specializations) ? c.specializations : [],
    branchCode: c.branch_code,
    email: c.email || '',
    phone: c.phone || '',
    qualifications: c.qualifications || '',
    bio: c.bio || '',
    avatarUrl: null,
    ratingAvg: null,
    ratingCount: null,
    createdAt: c.created_at,
  }))));
}));

const CreateCounsellorSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).optional().nullable(),
  password: z.string().min(6).optional().default('Brain@1234'),
  title: z.string().trim().max(100).optional().default('Counsellor'),
  qualifications: z.string().trim().max(255).optional().nullable(),
  specializations: z.array(z.string().trim()).optional().default([]),
  bio: z.string().trim().optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
});

appointmentRoutes.post('/', requireAuth(), validate(CreateCounsellorSchema), asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const allowedRoles = ['superadmin', 'Super Admin', 'brain_admin', 'Brain Admin'];
  const hasRole = auth.roles?.some(r => allowedRoles.includes(r));
  if (!hasRole) {
    throw ApiError.forbidden('Only Super Admin or Admin can create counsellors');
  }

  const d = req.body;
  const result = await tx(async (client) => {
    // Check if counsellor already exists
    const { rows: existingCounsellor } = await client.query<any>(`
      SELECT id FROM counsellors
      WHERE LOWER(email::text) = LOWER($1::text) AND deleted_at IS NULL
    `, [d.email]);
    if (existingCounsellor.length > 0) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'A counsellor with this email already exists', { field: 'email' });
    }

    // Resolve org & branch
    let orgId = auth.orgId;
    let branchId = d.branchId;
    if (!branchId || !orgId) {
      const { rows: branches } = await client.query<any>(`
        SELECT id, organization_id FROM branches WHERE is_active = TRUE ORDER BY created_at LIMIT 1
      `);
      if (branches.length > 0) {
        branchId = branchId || branches[0].id;
        orgId = orgId || branches[0].organization_id;
      }
    }

    // Find or create user
    let userId: string;
    const { rows: existingUsers } = await client.query<any>(`
      SELECT id FROM users WHERE LOWER(email::text) = LOWER($1::text) LIMIT 1
    `, [d.email]);

    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const passwordHash = await hashPassword(d.password || 'Brain@1234');
      const { rows: [newUser] } = await client.query<any>(`
        INSERT INTO users (organization_id, email, phone, password_hash, full_name, status, is_active)
        VALUES ($1, $2, $3, $4, $5, 'active', TRUE)
        RETURNING id
      `, [orgId, d.email, d.phone || null, passwordHash, d.fullName]);
      userId = newUser.id;
    }

    // Map role
    const { rows: [cRole] } = await client.query<any>(`
      SELECT id FROM roles WHERE code = 'counsellor' OR LOWER(name) = 'counsellor' LIMIT 1
    `);
    if (cRole) {
      await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [userId, cRole.id]);
    }

    // Insert counsellor
    const { rows: [counsellor] } = await client.query<any>(`
      INSERT INTO counsellors (
        organization_id, user_id, branch_id, full_name, email, phone,
        title, qualifications, specializations, bio, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
      RETURNING id, user_id, branch_id, full_name, email, phone,
                title, qualifications, specializations, bio, is_active, created_at
    `, [
      orgId,
      userId,
      branchId,
      d.fullName,
      d.email,
      d.phone || null,
      d.title || 'Counsellor',
      d.qualifications || null,
      d.specializations || [],
      d.bio || null
    ]);

    return counsellor;
  });

  res.status(201).json(success(result));
}));

appointmentRoutes.delete('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const allowedRoles = ['superadmin', 'Super Admin', 'brain_admin', 'Brain Admin'];
  const hasRole = auth.roles?.some(r => allowedRoles.includes(r));
  if (!hasRole) {
    throw ApiError.forbidden('Only Super Admin or Admin can delete counsellors');
  }

  const counsellorId = req.params.id;
  const { rows: [counsellor] } = await query<any>(`
    SELECT id, user_id FROM counsellors WHERE id = $1 AND deleted_at IS NULL
  `, [counsellorId]);

  if (!counsellor) {
    throw ApiError.notFound('Counsellor not found');
  }

  await query(`
    UPDATE counsellors
    SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW()
    WHERE id = $1
  `, [counsellorId]);

  if (counsellor.user_id) {
    await query(`
      UPDATE users
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1
    `, [counsellor.user_id]);
  }

  res.json(success({ message: 'Counsellor deleted successfully', id: counsellorId }));
}));

appointmentRoutes.get('/:id/availability', asyncHandler(async (req, res) => {
  const date = req.query.date as string || new Date().toISOString().slice(0, 10);
  const counsellorId = req.params.id;
  const { rows: slots } = await query<any>(`
    SELECT ts.id, ts.slot_start_time, ts.slot_end_time, ts.slot_time_display, ts.sort_order
    FROM time_slots ts
    WHERE ts.is_active = TRUE
    ORDER BY ts.sort_order
  `);
  const { rows: bookings } = await query<any>(`
    SELECT a.slot_start_time, a.slot_end_time
    FROM appointments a
    WHERE a.counsellor_id = $1 AND a.appointment_date = $2::DATE
      AND a.status != 'cancelled'
  `, [counsellorId, date]);
  const bookedStartTimes = new Set(bookings.map(b => String(b.slot_start_time)));

  res.json(success({
    date,
    counsellorId,
    slots: slots.map(s => ({
      timeSlotId: s.id,
      startTime: s.slot_time_display.split('–')[0].trim(),
      endTime: s.slot_time_display.split('–')[1]?.trim() || '',
      timeRangeDisplay: s.slot_time_display,
      isBooked: bookedStartTimes.has(String(s.slot_start_time)),
      slotStartTime: s.slot_start_time,
      slotEndTime: s.slot_end_time,
    })),
  }));
}));

const BookSchema = z.object({
  inquiryId: z.string().uuid(),
  counsellorId: z.string().uuid(),
  appointmentDate: z.string(),
  timeSlotId: z.string().uuid(),
  mode: z.enum(['in_person', 'online']),
  locationVenue: z.string().optional(),
  meetingLinkUrl: z.string().optional(),
  isPrimary: z.boolean().default(true),
  requirePaymentPaidGuard: z.boolean().default(true),
});

const QuickBookSchema = z.object({
  studentName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().min(7).max(30),
  mode: z.enum(['in_person', 'online']),
  module: z.enum(['Ankur', 'Palavi', 'Lakshya', 'Udaan', 'Phoenix', 'CMT']),
  counsellorId: z.string().uuid(),
  appointmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeDisplay: z.string().trim().min(1).max(50),
});

appointmentRoutes.post('/quick-book', requireAuth(), validate(QuickBookSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;

  const result = await tx(async (client) => {
    const { rows: [timeCheck] } = await client.query<any>(`
      SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today_ist,
             EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kolkata'))::int AS hour_ist
    `);
    if (timeCheck && d.appointmentDate === timeCheck.today_ist && timeCheck.hour_ist >= 17) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Same-day slot bookings are closed after 5:00 PM.', { field: 'appointmentDate' });
    }

    const { rows: [branch] } = await client.query<any>(`
      SELECT id FROM branches
      WHERE organization_id = $1 AND is_active = TRUE
      ORDER BY created_at LIMIT 1
    `, [auth.orgId]);
    if (!branch) throw ApiError.notFound('Active branch not found');

    const { rows: [program] } = await client.query<any>(`
      SELECT id, name FROM programs
      WHERE LOWER(name) = LOWER($1) AND is_active = TRUE
      LIMIT 1
    `, [d.module]);
    if (!program) throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Selected module is unavailable', { field: 'module' });

    const { rows: [counsellor] } = await client.query<any>(`
      SELECT id, full_name FROM counsellors
      WHERE id = $1 AND organization_id = $2 AND is_active = TRUE AND deleted_at IS NULL
    `, [d.counsellorId, auth.orgId]);
    if (!counsellor) throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Selected counsellor is unavailable', { field: 'counsellorId' });

    const { rows: [timeSlot] } = await client.query<any>(`
      SELECT id, slot_start_time, slot_end_time, slot_time_display
      FROM time_slots
      WHERE is_active = TRUE
        AND (slot_time_display = $1 OR UPPER(TO_CHAR(slot_start_time, 'HH12:MI AM')) = UPPER($1))
      LIMIT 1
    `, [d.timeDisplay]);
    if (!timeSlot) throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Selected time slot is unavailable', { field: 'timeDisplay' });

    const { rows: [duplicate] } = await client.query<any>(`
      SELECT 1 FROM appointments
      WHERE counsellor_id = $1 AND appointment_date = $2::DATE
        AND slot_start_time = $3::TIME AND status != 'cancelled'
      LIMIT 1
    `, [d.counsellorId, d.appointmentDate, timeSlot.slot_start_time]);
    if (duplicate) throw new ApiError('SLOT_DOUBLE_BOOKED', 'This slot has already been booked', 409);

    const suffix = Date.now().toString().slice(-10);
    const { rows: [student] } = await client.query<any>(`
      INSERT INTO students (
        organization_id, branch_id, full_name, email, phone, registration_number,
        gender, follow_up_frequency, is_active, registration_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'not_specified', 'weekly', TRUE, 'temporary')
      RETURNING id, registration_status
    `, [auth.orgId, branch.id, d.studentName, d.email, d.phone, `TMP-${suffix}`]);

    const dateKey = d.appointmentDate.replace(/-/g, '');
    const inquiryNumber = `BRAIN-${dateKey}-${suffix.slice(-6)}`;
    const formNumber = `FRM-${dateKey}-${suffix.slice(-6)}`;
    const { rows: [inquiry] } = await client.query<any>(`
      INSERT INTO inquiries (
        organization_id, branch_id, student_id, inquiry_number, registration_form_no,
        form_date, program_id, assigned_counsellor_id, status, fee_status, overall_progress_percent
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, 'appointment_booked', 'pending', 10)
      RETURNING id, inquiry_number, registration_form_no
    `, [auth.orgId, branch.id, student.id, inquiryNumber, formNumber, program.id, counsellor.id]);

    const { rows: [appointment] } = await client.query<any>(`
      INSERT INTO appointments (
        organization_id, inquiry_id, counsellor_id, branch_id,
        appointment_date, slot_start_time, slot_end_time, slot_time_display,
        mode, status, is_primary, booked_by
      ) VALUES ($1, $2, $3, $4, $5::DATE, $6, $7, $8, $9, 'booked', TRUE, $10)
      RETURNING id
    `, [auth.orgId, inquiry.id, counsellor.id, branch.id, d.appointmentDate,
      timeSlot.slot_start_time, timeSlot.slot_end_time, timeSlot.slot_time_display,
      d.mode, auth.userId]);

    return {
      appointmentId: appointment.id,
      inquiryId: inquiry.id,
      inquiryNumber: inquiry.inquiry_number,
      registrationFormNo: inquiry.registration_form_no,
      studentId: student.id,
      registrationStatus: student.registration_status,
      counsellorName: counsellor.full_name,
    };
  });

  res.status(201).json(success(result));
}));

appointmentRoutes.post('/', requireAuth(), validate(BookSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;
  const result = await tx(async (client) => {
    const { rows: [timeCheck] } = await client.query<any>(`
      SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today_ist,
             EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kolkata'))::int AS hour_ist
    `);
    if (timeCheck && d.appointmentDate === timeCheck.today_ist && timeCheck.hour_ist >= 17) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Same-day slot bookings are closed after 5:00 PM.', { field: 'appointmentDate' });
    }

    if (d.requirePaymentPaidGuard) {
      const { rows: [inq] } = await client.query<any>(
        `SELECT fee_status FROM inquiries WHERE id = $1`,
        [d.inquiryId]
      );
      if (inq.fee_status !== 'paid') {
        throw new ApiError('INQUIRY_GUARD_VIOLATION', 'Payment must be paid before booking appointment', 400);
      }
    }
    const { rows: [ts] } = await client.query<any>(
      `SELECT id, slot_start_time, slot_end_time, slot_time_display FROM time_slots WHERE id = $1`,
      [d.timeSlotId]
    );
    if (!ts) throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Time slot not found', { field: 'timeSlotId' });

    const { rows: [dup] } = await client.query<any>(`
      SELECT 1 FROM appointments
      WHERE counsellor_id = $1 AND appointment_date = $2::DATE
        AND slot_start_time = $3::TIME AND status != 'cancelled'
      LIMIT 1
    `, [d.counsellorId, d.appointmentDate, ts.slot_start_time]);
    if (dup) {
      throw new ApiError('SLOT_DOUBLE_BOOKED', 'This slot has been booked already', 409);
    }

    if (d.isPrimary) {
      await client.query(`
        UPDATE appointments SET is_primary = FALSE
        WHERE inquiry_id = $1 AND is_primary = TRUE AND status != 'cancelled'
      `, [d.inquiryId]);
    }

    const { rows: [inq2] } = await client.query<any>(
      `SELECT i.*, s.full_name, p.name AS program_name,
              (SELECT b.name FROM branches b WHERE b.id = i.branch_id) AS branch_name,
              (SELECT b.address_line1 FROM branches b WHERE b.id = i.branch_id) AS branch_addr
       FROM inquiries i
       JOIN students s ON s.id = i.student_id
       LEFT JOIN programs p ON p.id = i.program_id
       WHERE i.id = $1`,
      [d.inquiryId]
    );
    const { rows: [c] } = await client.query<any>(
      `SELECT full_name, title FROM counsellors WHERE id = $1`,
      [d.counsellorId]
    );

    const voucherNo = 'VCH-' + Date.now().toString().slice(-10);
    const { rows: [apt] } = await client.query<any>(`
      INSERT INTO appointments (
        organization_id, inquiry_id, counsellor_id, branch_id,
        appointment_date, slot_start_time, slot_end_time, slot_time_display,
        mode, location, join_url, status, is_primary, booked_by
      ) SELECT
          organization_id, $1, $2, branch_id,
          $3::DATE, $4, $5, $6,
          $7, COALESCE($8, branch_address_col.addr), $9, 'booked', $10, $11
        FROM (
          SELECT organization_id, COALESCE(branch_id, (SELECT id FROM branches WHERE organization_id = (SELECT organization_id FROM inquiries WHERE id = $1) LIMIT 1)) AS branch_id,
                 (SELECT address_line1 FROM branches WHERE id = COALESCE((SELECT branch_id FROM inquiries WHERE id = $1), (SELECT id FROM branches LIMIT 1))) AS addr
          FROM inquiries WHERE id = $1
        ) branch_address_col
        RETURNING id, appointment_date, mode, location, join_url
    `, [
      d.inquiryId, d.counsellorId,
      d.appointmentDate, ts.slot_start_time, ts.slot_end_time, ts.slot_time_display,
      d.mode, d.locationVenue || inq2?.branch_addr || null, d.meetingLinkUrl || null,
      d.isPrimary, auth.userId,
    ]);

    await client.query(
      `UPDATE inquiries SET status = 'appointment_booked', overall_progress_percent = GREATEST(overall_progress_percent, 60) WHERE id = $1`,
      [d.inquiryId]
    );

    return {
      appointmentId: apt.id,
      voucher: {
        id: apt.id,
        voucherPrintNumber: voucherNo,
        inquiryNumber: inq2?.inquiry_number,
        registrationFormNo: inq2?.registration_form_no,
        studentName: inq2?.full_name || '',
        programName: inq2?.program_name || '',
        mode: apt.mode,
        dateText: apt.appointment_date,
        timeText: ts.slot_time_display,
        counsellorName: c?.full_name || '',
        counsellorTitle: c?.title || '',
        venueAddress: apt.location || inq2?.branch_addr || '',
        feeAmount: inq2?.program_id ? 0 : 0,
        feePaidStatus: 'PAID' as const,
        qrPayload: `brain:apt:${apt.id}:${Date.now()}`,
        cancellationPolicy: 'Free reschedule up to 24h before; 50% cancellation fee within 24h.',
        printedAt: new Date().toISOString(),
      },
      notificationsSent: { sms: false, email: false },
    };
  });

  res.status(201).json(success(result));
}));

appointmentRoutes.get('/inquiry/:inquiryId/history', requireAuth(), asyncHandler(async (req, res) => {
  const { rows } = await query<any>(`
    SELECT a.id, a.appointment_date, a.slot_time_display, a.mode,
           a.location, a.join_url, a.status, a.is_primary,
           c.id AS counsellor_id, c.full_name AS counsellor_name, c.title,
           a.created_at
    FROM appointments a
    JOIN counsellors c ON c.id = a.counsellor_id
    WHERE a.inquiry_id = $1
    ORDER BY a.appointment_date DESC, a.slot_start_time DESC
  `, [req.params.inquiryId]);
  res.json(success(rows.map(a => ({
    id: a.id, date: a.appointment_date, timeSlotDisplay: a.slot_time_display,
    mode: a.mode, venueAddress: a.location, meetingLinkUrl: a.join_url,
    status: a.status,
    counsellor: {
      id: a.counsellor_id, userId: null, fullName: a.counsellor_name, title: a.title || 'Counsellor',
      specializations: [],
    },
    isPrimary: a.is_primary,
    createdAt: a.created_at,
  }))));
}));

const RescheduleSchema = z.object({
  newDate: z.string(),
  newTimeSlotId: z.string().uuid().optional(),
  newCounsellorId: z.string().uuid().optional(),
  reason: z.string().min(2),
});
appointmentRoutes.patch('/:id/reschedule', requireAuth(), validate(RescheduleSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const result = await tx(async (client) => {
    const { rows: [old] } = await client.query<any>(`SELECT * FROM appointments WHERE id = $1`, [req.params.id]);
    if (!old) throw ApiError.notFound('Appointment not found');
    await client.query(`UPDATE appointments SET status='rescheduled' WHERE id=$1`, [req.params.id]);
    const newCounsellor = d.newCounsellorId || old.counsellor_id;
    let ts;
    if (d.newTimeSlotId) {
      const { rows } = await client.query<any>(
        `SELECT slot_start_time, slot_end_time, slot_time_display FROM time_slots WHERE id = $1`,
        [d.newTimeSlotId]
      );
      ts = rows[0];
    }
    if (!ts) ts = { slot_start_time: old.slot_start_time, slot_end_time: old.slot_end_time, slot_time_display: old.slot_time_display };

    const voucherNo = 'VCH-' + Date.now().toString().slice(-10);
    const { rows: [napt] } = await client.query<any>(`
      INSERT INTO appointments (
        organization_id, inquiry_id, counsellor_id, branch_id,
        appointment_date, slot_start_time, slot_end_time, slot_time_display,
        mode, location, join_url, status, is_primary,
        rescheduled_from_appointment_id, rescheduled_reason, booked_by
      ) VALUES (
        $1, $2, $3, $4, $5::DATE, $6, $7, $8, $9, $10, $11, 'booked', TRUE,
        $12, $13, $14
      ) RETURNING id
    `, [old.organization_id, old.inquiry_id, newCounsellor, old.branch_id,
        d.newDate, ts.slot_start_time, ts.slot_end_time, ts.slot_time_display,
        old.mode, old.location, old.join_url,
        old.id, d.reason, req.auth!.userId]);
    return {
      appointmentId: napt.id,
      date: d.newDate,
      timeText: ts.slot_time_display,
      voucherPrintNumber: voucherNo,
    };
  });
  res.json(success(result));
}));

const CancelSchema = z.object({ reason: z.string().min(2), notify: z.boolean().default(false) });
appointmentRoutes.patch('/:id/cancel', requireAuth(), validate(CancelSchema), asyncHandler(async (req, res) => {
  await query(
    `UPDATE appointments SET status='cancelled', cancelled_reason=$1, cancelled_at=NOW() WHERE id=$2`,
    [req.body.reason, req.params.id]
  );
  res.json(success({ ok: true, status: 'cancelled' } as any));
}));

// GET /api/v1/appointments/sessions - List counselling sessions across inquiries
appointmentRoutes.get('/sessions', requireAuth(), asyncHandler(async (req, res) => {
  let { status, counsellorId, branchId, date, inquiryId } = req.query as {
    status?: string;
    counsellorId?: string;
    branchId?: string;
    date?: string;
    inquiryId?: string;
  };

  // A counsellor dashboard must always be scoped from the authenticated user,
  // rather than relying on the browser to know or submit the profile id.
  if (req.auth!.roles.includes('counsellor')) {
    const { rows: [profile] } = await query<any>(`
      SELECT id FROM counsellors
      WHERE user_id = $1 AND organization_id = $2 AND deleted_at IS NULL
      LIMIT 1
    `, [req.auth!.userId, req.auth!.orgId]);
    if (!profile) throw ApiError.notFound('Counsellor profile not found');
    counsellorId = profile.id;
  }

  const params: any[] = [req.auth!.orgId];
  let pIdx = 1;
  let sql = `
    SELECT 
      a.id AS appointment_id,
      a.inquiry_id,
      a.counsellor_id,
      a.branch_id,
      a.appointment_date,
      a.slot_start_time,
      a.slot_end_time,
      a.slot_time_display,
      a.mode,
      a.location,
      a.join_url AS meeting_link_url,
      a.status AS appointment_status,
      cs.id AS session_id,
      COALESCE(cs.status::text, CASE WHEN a.status = 'completed' THEN 'completed' ELSE 'scheduled' END) AS session_status,
      cs.session_started_at,
      cs.session_ended_at,
      cs.duration_seconds,
      cs.student_attended,
      cs.counsellor_notes,
      cs.venue_location,
      s.full_name AS student_name,
      s.email AS student_email,
      s.phone AS student_phone,
      s.registration_number,
      i.inquiry_number,
      i.status AS inquiry_status,
      p.name AS program_name,
      p.code AS program_code,
      c.full_name AS counsellor_name,
      c.title AS counsellor_title,
      b.name AS branch_name
    FROM appointments a
    LEFT JOIN counselling_sessions cs ON cs.appointment_id = a.id
    JOIN inquiries i ON i.id = a.inquiry_id
    JOIN students s ON s.id = i.student_id
    LEFT JOIN programs p ON p.id = i.program_id
    JOIN counsellors c ON c.id = a.counsellor_id
    LEFT JOIN branches b ON b.id = a.branch_id
    WHERE a.organization_id = $${pIdx++}
  `;

  if (inquiryId) {
    sql += ` AND a.inquiry_id = $${pIdx++}`;
    params.push(inquiryId);
  }
  if (counsellorId) {
    sql += ` AND a.counsellor_id = $${pIdx++}`;
    params.push(counsellorId);
  }
  if (branchId) {
    sql += ` AND a.branch_id = $${pIdx++}`;
    params.push(branchId);
  }
  if (date) {
    sql += ` AND a.appointment_date = $${pIdx++}::DATE`;
    params.push(date);
  }
  if (status) {
    if (status === 'upcoming') {
      sql += ` AND (a.status = 'booked' OR cs.status = 'scheduled')`;
    } else if (status === 'completed') {
      sql += ` AND (a.status = 'completed' OR cs.status = 'completed')`;
    } else if (status === 'in_progress') {
      sql += ` AND cs.status = 'in_progress'`;
    } else if (status === 'cancelled') {
      sql += ` AND a.status = 'cancelled'`;
    }
  }

  sql += ` ORDER BY a.appointment_date DESC, a.slot_start_time DESC`;

  const { rows } = await query<any>(sql, params);

  const sessions = rows.map(r => ({
    id: r.session_id || r.appointment_id,
    sessionId: r.session_id,
    appointmentId: r.appointment_id,
    inquiryId: r.inquiry_id,
    inquiryNumber: r.inquiry_number,
    inquiryStatus: r.inquiry_status,
    student: {
      name: r.student_name,
      email: r.student_email,
      phone: r.student_phone,
      registrationNumber: r.registration_number,
    },
    programName: r.program_name,
    programCode: r.program_code,
    counsellor: {
      id: r.counsellor_id,
      name: r.counsellor_name,
      title: r.counsellor_title || 'Counsellor',
    },
    branchName: r.branch_name,
    date: r.appointment_date,
    timeSlotDisplay: r.slot_time_display,
    mode: r.mode,
    location: r.location || r.venue_location,
    meetingLinkUrl: r.meeting_link_url,
    status: r.session_status,
    appointmentStatus: r.appointment_status,
    sessionStartedAt: r.session_started_at,
    sessionEndedAt: r.session_ended_at,
    durationSeconds: r.duration_seconds,
    studentAttended: r.student_attended,
    counsellorNotes: r.counsellor_notes,
  }));

  res.json(success(sessions));
}));

const StartSessionSchema = z.object({
  notes: z.string().optional(),
});

// POST /api/v1/appointments/:id/start-session
appointmentRoutes.post('/:id/start-session', requireAuth(), validate(StartSessionSchema), asyncHandler(async (req, res) => {
  const appointmentId = req.params.id;
  const { notes } = req.body;

  const result = await tx(async (client) => {
    // Check appointment
    const { rows: [apt] } = await client.query<any>(
      `SELECT a.*, i.student_id FROM appointments a
       JOIN inquiries i ON i.id=a.inquiry_id WHERE a.id = $1`,
      [appointmentId]
    );
    if (!apt) throw ApiError.notFound('Appointment not found');

    // Check if session row exists or create one
    const { rows: [existingSession] } = await client.query<any>(
      `SELECT * FROM counselling_sessions WHERE appointment_id = $1`,
      [appointmentId]
    );

    let session;
    if (existingSession) {
      const { rows: [updated] } = await client.query<any>(
        `UPDATE counselling_sessions
         SET status = 'in_progress',
             session_started_at = COALESCE(session_started_at, NOW()),
             student_attended = TRUE,
             counsellor_notes = COALESCE($2, counsellor_notes),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existingSession.id, notes || null]
      );
      session = updated;
    } else {
      const { rows: [created] } = await client.query<any>(
        `INSERT INTO counselling_sessions (
           appointment_id, inquiry_id, student_id, counsellor_id, organization_id,
           status, session_started_at, student_attended,
           counsellor_notes, mode, venue_location
         ) VALUES (
           $1, $2, $3, $4, $5,
           'in_progress', NOW(), TRUE,
           $6, $7, $8
         ) RETURNING *`,
        [
          apt.id,
          apt.inquiry_id,
          apt.student_id,
          apt.counsellor_id,
          apt.organization_id,
          notes || null,
          apt.mode,
          apt.location,
        ]
      );
      session = created;
    }

    // Update inquiry progress/status
    await client.query(
      `UPDATE inquiries 
       SET status = 'session_in_progress', overall_progress_percent = GREATEST(overall_progress_percent, 70), updated_at = NOW()
       WHERE id = $1`,
      [apt.inquiry_id]
    );

    return {
      session,
      message: 'Counselling session started successfully',
    };
  });

  res.json(success(result));
}));

const CompleteSessionSchema = z.object({
  counsellorNotes: z.string().optional(),
  studentAttended: z.boolean().default(true),
  durationSeconds: z.number().int().nonnegative().optional(),
});

// POST /api/v1/appointments/:id/complete-session
appointmentRoutes.post('/:id/complete-session', requireAuth(), validate(CompleteSessionSchema), asyncHandler(async (req, res) => {
  const appointmentId = req.params.id;
  const { counsellorNotes, studentAttended, durationSeconds } = req.body;

  const result = await tx(async (client) => {
    const { rows: [apt] } = await client.query<any>(
      `SELECT a.*, i.student_id FROM appointments a
       JOIN inquiries i ON i.id=a.inquiry_id WHERE a.id = $1`,
      [appointmentId]
    );
    if (!apt) throw ApiError.notFound('Appointment not found');

    const { rows: [existingSession] } = await client.query<any>(
      `SELECT * FROM counselling_sessions WHERE appointment_id = $1`,
      [appointmentId]
    );

    let session;
    if (existingSession) {
      const calcDuration = durationSeconds !== undefined 
        ? durationSeconds 
        : (existingSession.session_started_at ? Math.round((Date.now() - new Date(existingSession.session_started_at).getTime()) / 1000) : 1800);

      const { rows: [updated] } = await client.query<any>(
        `UPDATE counselling_sessions
         SET status = 'completed',
             session_ended_at = NOW(),
             duration_seconds = $2,
             student_attended = $3,
             counsellor_notes = COALESCE($4, counsellor_notes),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existingSession.id, calcDuration, studentAttended, counsellorNotes || null]
      );
      session = updated;
    } else {
      const { rows: [created] } = await client.query<any>(
        `INSERT INTO counselling_sessions (
           appointment_id, inquiry_id, student_id, counsellor_id, organization_id,
           status, session_started_at, session_ended_at, duration_seconds,
           student_attended, counsellor_notes, mode, venue_location
         ) VALUES (
           $1, $2, $3, $4, $5,
           'completed', NOW() - INTERVAL '30 minutes', NOW(), $6,
           $7, $8, $9, $10
         ) RETURNING *`,
        [
          apt.id,
          apt.inquiry_id,
          apt.student_id,
          apt.counsellor_id,
          apt.organization_id,
          durationSeconds || 1800,
          studentAttended,
          counsellorNotes || null,
          apt.mode,
          apt.location,
        ]
      );
      session = created;
    }

    // Update appointment status to completed
    await client.query(
      `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [appointmentId]
    );

    // Update inquiry progress/status
    await client.query(
      `UPDATE inquiries 
       SET status = 'session_completed', overall_progress_percent = GREATEST(overall_progress_percent, 80), updated_at = NOW()
       WHERE id = $1`,
      [apt.inquiry_id]
    );

    return {
      session,
      message: 'Counselling session completed successfully',
    };
  });

  res.json(success(result));
}));
