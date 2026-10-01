import { Router } from 'express';
export const inquiryRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError, PaisaOrINR, UUID } from '../types/api';
import { query, tx } from '../config/db';

inquiryRoutes.use(requireAuth());

const CreateInquirySchema = z.object({
  studentId: z.string().uuid().optional(),
  referralCodeText: z.string().optional(),
});

inquiryRoutes.post('/', validate(CreateInquirySchema), asyncHandler(async (req, res) => {
  const { studentId, referralCodeText } = req.body;
  const auth = req.auth!;

  const result = await tx(async (client) => {
    const orgId = auth.orgId;
    const { rows: branchRows } = await client.query<any>(
      `SELECT id, code FROM branches
       WHERE organization_id = $1 AND is_active = TRUE
       ORDER BY created_at LIMIT 1`,
      [orgId]
    );
    if (branchRows.length === 0) throw ApiError.notFound('Branch not found');
    const branch = branchRows[0];

    let resolvedStudentId = studentId;
    if (!resolvedStudentId) {
      const { rows: stuRows } = await client.query<any>(
        `SELECT id FROM students WHERE user_id = $1 AND organization_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [auth.userId, orgId]
      );
      if (stuRows.length === 0) {
        const regNo = 'STU-' + Date.now().toString().slice(-8);
        const { rows: uRows } = await client.query<any>(
          `SELECT full_name, email, phone FROM users WHERE id = $1`, [auth.userId]
        );
        const u = uRows[0] || { full_name: 'Guest Student', email: null, phone: null };
        const { rows: newStu } = await client.query<any>(`
          INSERT INTO students (organization_id, branch_id, user_id, full_name, email, phone, registration_number, gender, follow_up_frequency, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_specified', 'weekly', TRUE)
          RETURNING id
        `, [orgId, branch.id, auth.userId, u.full_name, u.email, u.phone, regNo]);
        resolvedStudentId = newStu[0].id;
      } else {
        resolvedStudentId = stuRows[0].id;
      }
    }

    let referralCodeId: any = null;
    let referralApplied: any = null;
    if (referralCodeText) {
      const { rows: rcRows } = await client.query<any>(`
        SELECT rc.id, rc.code, rc.referrer_full_name
        FROM referral_codes rc
        WHERE UPPER(rc.code) = UPPER($1) AND rc.status = 'active' AND rc.is_active = TRUE AND rc.deleted_at IS NULL
          AND (rc.valid_until IS NULL OR rc.valid_until >= NOW())
        LIMIT 1
      `, [referralCodeText]);
      if (rcRows[0]) {
        referralCodeId = rcRows[0].id;
        referralApplied = {
          referralCodeId: rcRows[0].id,
          codeText: rcRows[0].code,
          referrerName: rcRows[0].referrer_full_name || null,
        };
      }
    }

    const today = new Date();
    const ymd = today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');
    const { rows: seqRow } = await client.query<any>(
      `SELECT COALESCE(MAX(CAST(SPLIT_PART(inquiry_number, '-', 3) AS INTEGER)), 0) + 1 AS nxt
       FROM inquiries WHERE inquiry_number LIKE $1`,
      [`BRAIN-${ymd}-%`]
    );
    const seq = String(seqRow[0].nxt || 1).padStart(6, '0');
    const inquiryNumber = `BRAIN-${ymd}-${seq}`;
    const formNo = `FRM-${ymd}-${seq}`;

    const { rows: ins } = await client.query<any>(`
      INSERT INTO inquiries (
        organization_id, branch_id, student_id, inquiry_number, registration_form_no,
        form_date, referral_code_id, referral_code_text_entered, overall_progress_percent
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, 0)
      RETURNING id, inquiry_number, registration_form_no, overall_progress_percent, created_at
    `, [orgId, branch.id, resolvedStudentId, inquiryNumber, formNo, referralCodeId, referralCodeText || null]);

    return { inquiry: ins[0], referralApplied };
  });

  res.status(201).json(success({
    inquiryId: result.inquiry.id,
    inquiryNumber: result.inquiry.inquiry_number,
    registrationFormNo: result.inquiry.registration_form_no,
    currentStep: 1,
    overallProgressPercent: parseInt(result.inquiry.overall_progress_percent || 0),
    createdAt: result.inquiry.created_at,
    referralApplied: result.referralApplied,
  }));
}));

inquiryRoutes.get('/next-registration-number', asyncHandler(async (_req, res) => {
  res.json(success({ formNo: 'FRM-' + Date.now() }));
}));

inquiryRoutes.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string || '1');
  const perPage = parseInt(req.query.perPage as string || '20');
  const offset = (page - 1) * perPage;
  const auth = req.auth!;

  const isAdmin = auth.roles.includes('superadmin') || auth.roles.includes('brain_admin') || auth.roles.includes('admin');
  const baseWhere = isAdmin
    ? `WHERE i.organization_id = $1 AND i.deleted_at IS NULL`
    : `WHERE i.organization_id = $1 AND i.deleted_at IS NULL AND (
         i.student_id IN (SELECT id FROM students WHERE user_id = $2)
         OR i.current_counsellor_id IN (SELECT id FROM counsellors WHERE user_id = $2)
         OR i.assigned_counsellor_id IN (SELECT id FROM counsellors WHERE user_id = $2)
         OR i.id IN (SELECT a.inquiry_id FROM appointments a WHERE a.counsellor_id IN (SELECT id FROM counsellors WHERE user_id = $2))
      )`;
  const params: any[] = isAdmin ? [auth.orgId] : [auth.orgId, auth.userId];

  const { rows: countRows } = await query<any>(
    `SELECT COUNT(*)::int AS total FROM inquiries i ${baseWhere}`, params
  );
  const total = countRows[0].total;

  const { rows } = await query<any>(`
    SELECT i.id, i.inquiry_number, i.registration_form_no, i.status, i.fee_status,
           i.overall_progress_percent, i.created_at,
           s.id AS student_id, s.full_name AS student_name, s.photo_storage_key, s.phone AS student_phone,
           p.code AS program_code, p.name AS program_name, p.price,
           c.id AS counsellor_id, c.full_name AS counsellor_name,
           b.code AS branch_code, b.name AS branch_name,
           (SELECT MAX(paid_at) FROM payments WHERE inquiry_id = i.id AND status='paid') AS latest_paid_at,
           COALESCE((SELECT SUM(total_amount) FROM payments WHERE inquiry_id = i.id AND status='paid'), 0) AS paid_amount,
           COALESCE((SELECT SUM(total_amount) FROM payments WHERE inquiry_id = i.id AND status='paid'), 0) AS fee_total
    FROM inquiries i
    JOIN students s ON s.id = i.student_id
    LEFT JOIN programs p ON p.id = i.program_id
    LEFT JOIN counsellors c ON c.id = COALESCE(i.current_counsellor_id, i.assigned_counsellor_id)
    LEFT JOIN branches b ON b.id = i.branch_id
    ${baseWhere}
    ORDER BY i.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `, params);

  const items = rows.map(r => ({
    id: r.id,
    inquiryNumber: r.inquiry_number,
    registrationFormNo: r.registration_form_no,
    status: r.status,
    feeStatus: r.fee_status,
    overallProgressPercent: parseInt(r.overall_progress_percent || 0),
    student: { id: r.student_id, fullName: r.student_name, photoUrl: r.photo_storage_key, phone: r.student_phone },
    program: r.program_code ? { code: r.program_code, name: r.program_name, price: parseFloat(r.price || 0) } : null,
    counsellor: r.counsellor_id ? { id: r.counsellor_id, fullName: r.counsellor_name } : null,
    branch: r.branch_code ? { code: r.branch_code, name: r.branch_name } : null,
    nextFollowUp: null,
    feePaidAmount: parseFloat(r.paid_amount || 0),
    feeTotalAmount: parseFloat(r.fee_total || 0),
    latestPaymentAt: r.latest_paid_at,
    createdAt: r.created_at,
  }));

  const { rows: summaryRows } = await query<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE organization_id = $1 AND deleted_at IS NULL) AS total_students,
      (SELECT COALESCE(SUM(total_amount), 0)::numeric FROM payments WHERE organization_id = $1 AND status = 'paid') AS total_revenue,
      (SELECT COUNT(*)::int FROM follow_up_records WHERE next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE) AS pending_followups,
      (SELECT COUNT(*)::int FROM appointments a
        WHERE a.organization_id = $1 AND a.status = 'booked'
          AND a.appointment_date = CURRENT_DATE) AS sessions_today
  `, [auth.orgId]);
  const sr = summaryRows[0] || {};

  res.json({
    ok: true,
    data: items,
    meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) || 1 },
    summaryTiles: {
      totalStudents: sr.total_students || 0,
      totalRevenue: parseFloat(sr.total_revenue || 0),
      pendingFollowUps: sr.pending_followups || 0,
      sessionsToday: sr.sessions_today || 0,
    },
    timestamp: new Date().toISOString(),
  });
}));

inquiryRoutes.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const auth = req.auth!;
  const { rows } = await query<any>(`
    SELECT i.*, s.full_name AS student_name, s.email AS student_email, s.phone AS student_phone,
           s.registration_number AS student_reg_no, s.photo_storage_key,
           p.code AS program_code, p.name AS program_name, p.tagline, p.grade_range,
           p.description, p.price, p.gradient_classes, p.icon_name
    FROM inquiries i
    JOIN students s ON s.id = i.student_id
    LEFT JOIN programs p ON p.id = i.program_id
    WHERE i.id = $1 AND i.organization_id = $2 AND i.deleted_at IS NULL
  `, [id, auth.orgId]);
  if (rows.length === 0) throw ApiError.notFound('Inquiry not found');
  const i = rows[0];

  res.json(success({
    id: i.id,
    inquiryNumber: i.inquiry_number,
    registrationFormNo: i.registration_form_no,
    organizationId: i.organization_id,
    branchId: i.branch_id,
    studentId: i.student_id,
    student: {
      id: i.student_id, fullName: i.student_name, email: i.student_email,
      phone: i.student_phone, registrationNumber: i.student_reg_no,
      photoStorageKey: i.photo_storage_key,
    },
    status: i.status,
    currentStep: 1,
    feeStatus: i.fee_status,
    overallProgressPercent: parseInt(i.overall_progress_percent || 0),
    programId: i.program_id,
    programSnapshot: i.program_code ? {
      id: i.program_id,
      code: i.program_code, name: i.program_name, tagline: i.tagline,
      gradeRange: i.grade_range, description: i.description,
      features: [],
      price: parseFloat(i.price || 0),
      currency: 'INR',
      gradientCssClasses: i.gradient_classes || '',
      iconName: i.icon_name || '',
      isActive: true,
    } : null,
    formDate: i.form_date,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  }));
}));

const PersonalSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email().nullish(),
  phone: z.string().min(7),
  alternatePhone: z.string().nullish(),
  dateOfBirth: z.string().nullish(),
  gender: z.string().nullish(),
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  pincode: z.string().nullish(),
  parentName: z.string().nullish(),
  parentPhone: z.string().nullish(),
  parentOccupation: z.string().nullish(),
  photoStorageKey: z.string().nullish(),
  regNo: z.string().nullish(),
  formDate: z.string().nullish(),
});

inquiryRoutes.post('/:id/personal-details', validate(PersonalSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  await tx(async (client) => {
    const { rows: lookup } = await client.query<any>(
      `SELECT id, student_id FROM inquiries WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, req.auth!.orgId]
    );
    if (lookup.length === 0) throw ApiError.notFound('Inquiry not found');
    const stuId = lookup[0].student_id;

    let genderVal: string = d.gender || 'not_specified';
    if (['male', 'female', 'other', 'not_specified'].includes(genderVal.toLowerCase())) {
      genderVal = genderVal.toLowerCase();
    } else {
      genderVal = 'not_specified';
    }

    await client.query(`
      UPDATE students SET
        full_name = $1, email = $2, phone = $3, phone_whatsapp = $4,
        date_of_birth = $5::DATE, gender = $6::gender_enum,
        address_line1 = $7, address_line2 = $8,
        city = $9, state = $10, pincode = $11,
        photo_storage_key = $12,
        registration_number = COALESCE($13, registration_number)
      WHERE id = $14
    `, [d.fullName, d.email, d.phone, d.alternatePhone,
        d.dateOfBirth || null, genderVal,
        d.addressLine1, d.addressLine2, d.city, d.state, d.pincode,
        d.photoStorageKey || null,
        d.regNo || null, stuId]);

    if (d.parentName || d.parentPhone || d.parentOccupation) {
      const { rows: pLookup } = await client.query<any>(
        `SELECT p.id FROM parents p WHERE p.user_id = (SELECT user_id FROM students WHERE id=$1) ORDER BY created_at DESC LIMIT 1`,
        [stuId]
      );
      if (pLookup.length > 0) {
        await client.query(`
          UPDATE parents SET full_name = COALESCE($1, full_name), phone = COALESCE($2, phone),
            occupation = COALESCE($3, occupation) WHERE id = $4
        `, [d.parentName || null, d.parentPhone || null, d.parentOccupation || null, pLookup[0].id]);
      } else {
        const { rows: u } = await client.query<any>(
          `SELECT organization_id, user_id FROM students WHERE id = $1`, [stuId]
        );
        await client.query(`
          INSERT INTO parents (organization_id, user_id, full_name, phone, occupation, relationship_to_student, is_primary_contact, is_active)
          VALUES ($1, $2, $3, $4, $5, 'parent', TRUE, TRUE)
        `, [u[0]?.organization_id, u[0]?.user_id || null, d.parentName || 'Parent', d.parentPhone || null, d.parentOccupation || null]);
      }
    }

    await client.query(
      `UPDATE inquiries SET overall_progress_percent = GREATEST(overall_progress_percent, 20) WHERE id = $1`,
      [id]
    );
  });
  res.json(success({ ok: true, stepAdvancedTo: 1 } as any));
}));

const ProgramSchema = z.object({
  programId: z.string().uuid(),
  referralCodeText: z.string().optional(),
});

inquiryRoutes.post('/:id/select-program', validate(ProgramSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { programId, referralCodeText } = req.body;
  const auth = req.auth!;

  const result = await tx(async (client) => {
    const { rows: pRows } = await client.query<any>(
      `SELECT *, service_fee_rate_percent, gst_rate_percent FROM programs WHERE id = $1 AND is_active = TRUE`,
      [programId]
    );
    if (pRows.length === 0) throw ApiError.notFound('Program not found');
    const p = pRows[0];
    const programFee = parseFloat(p.price);
    const serviceFeePercent = parseFloat(p.service_fee_rate_percent || 5);
    const serviceFeeAmount = Math.round(programFee * serviceFeePercent * 100) / 10000;
    const gstPercent = parseFloat(p.gst_rate_percent || 18);
    const gstAmount = Math.round((programFee + serviceFeeAmount) * gstPercent * 100) / 10000;
    const subtotalBeforeDiscount = Math.round((programFee + serviceFeeAmount + gstAmount) * 100) / 100;

    let referralCodeId: any = null;
    let discountType: any = null;
    let discountValueApplied: any = null;
    let discountAmountApplied = 0;
    let referralValidated: any = null;
    if (referralCodeText) {
      const { rows: rc } = await client.query<any>(`
        SELECT * FROM referral_codes WHERE UPPER(code) = UPPER($1) AND status='active' AND is_active=TRUE AND deleted_at IS NULL
          AND (valid_until IS NULL OR valid_until >= NOW())
        LIMIT 1
      `, [referralCodeText]);
      if (rc[0]) {
        referralCodeId = rc[0].id;
        discountType = rc[0].discount_type;
        const dv = parseFloat(rc[0].discount_value);
        const maxCap = rc[0].max_discount_amount_cap ? parseFloat(rc[0].max_discount_amount_cap) : null;
        if (rc[0].discount_type === 'percentage') {
          discountValueApplied = dv;
          discountAmountApplied = Math.min(
            maxCap ?? Infinity,
            Math.round((subtotalBeforeDiscount * dv) / 100 * 100) / 100
          );
        } else {
          discountValueApplied = dv;
          discountAmountApplied = Math.min(maxCap ?? dv, dv);
        }
        referralValidated = {
          isValid: true,
          codeId: rc[0].id,
          displayCode: rc[0].code,
          discountType: rc[0].discount_type,
          discountValue: dv,
          discountPreviewAmount: discountAmountApplied,
        };
      }
    }

    const totalAfterDiscount = Math.round((subtotalBeforeDiscount - discountAmountApplied) * 100) / 100;
    const roundOff = Math.round((totalAfterDiscount - Math.round(totalAfterDiscount)) * 100) / 100;
    const grandTotal = Math.round((totalAfterDiscount + roundOff) * 100) / 100;

    await client.query(`
      UPDATE inquiries SET
        program_id = $1,
        status = CASE WHEN status = 'draft' THEN 'program_selected' ELSE status END,
        referral_code_id = $2,
        referral_code_text_entered = $3,
        overall_progress_percent = GREATEST(overall_progress_percent, 40)
      WHERE id = $4
    `, [programId, referralCodeId, referralCodeText || null, id]);

    return { p, feeBreakdown: {
      programFee, serviceFeePercent, serviceFeeAmount, gstPercent, gstAmount,
      subtotalBeforeDiscount, referralCodeId, referralCodeText: referralCodeText || null,
      discountType, discountValueApplied, discountAmountApplied,
      roundOffAdjustmentAmount: roundOff, totalAfterDiscount, grandTotal, currency: 'INR' as const,
    }, referralValidated };
  });

  res.json(success({
    ok: true,
    program: {
      id: result.p.id,
      code: result.p.code, name: result.p.name, tagline: result.p.tagline,
      gradeRange: result.p.grade_range, description: result.p.description,
      features: [],
      price: parseFloat(result.p.price),
      currency: 'INR',
      gradientCssClasses: result.p.gradient_classes || '',
      iconName: result.p.icon_name || '',
      isActive: true,
    },
    referralValidated: result.referralValidated ?? null,
    feeBreakdown: result.feeBreakdown,
    requiredNext: 'PAYMENT_INITIATE',
  }));
}));

inquiryRoutes.post('/:id/submit-registration-form', asyncHandler(async (req, res) => {
  await query(
    `UPDATE inquiries SET status='personal_submitted', overall_progress_percent = GREATEST(overall_progress_percent, 25) WHERE id = $1`,
    [req.params.id]
  );
  res.json(success({ ok: true, stepAdvancedTo: 2, requiredNext: 'PROGRAM_SELECTION' }));
}));

const AssignSchema = z.object({ counsellorId: z.string().uuid() });
inquiryRoutes.post('/:id/assign-counsellor', validate(AssignSchema), asyncHandler(async (req, res) => {
  const { counsellorId } = req.body;
  await query(
    `UPDATE inquiries SET current_counsellor_id = $1, assigned_counsellor_id = $1 WHERE id = $2`,
    [counsellorId, req.params.id]
  );
  res.json(success({ ok: true } as any));
}));

inquiryRoutes.post('/:id/reset-flow', asyncHandler(async (req, res) => {
  const r = await tx(async (client) => {
    const { rows: [old] } = await client.query<any>(`SELECT * FROM inquiries WHERE id = $1`, [req.params.id]);
    if (!old) throw ApiError.notFound('Inquiry not found');
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { rows: [s] } = await client.query<any>(
      `SELECT COALESCE(MAX(CAST(SPLIT_PART(inquiry_number, '-', 3) AS INTEGER)), 0) + 1 AS n FROM inquiries WHERE inquiry_number LIKE $1`,
      [`BRAIN-${ymd}-%`]
    );
    const seq = String(s.n || 1).padStart(6, '0');
    const newInqNo = `BRAIN-${ymd}-${seq}`;
    const newFormNo = `FRM-${ymd}-${seq}`;
    const { rows: [nq] } = await client.query<any>(`
      INSERT INTO inquiries (organization_id, branch_id, student_id, inquiry_number, registration_form_no, form_date, overall_progress_percent)
      SELECT organization_id, branch_id, student_id, $1, $2, CURRENT_DATE, 0
      FROM inquiries WHERE id = $3
      RETURNING id, inquiry_number
    `, [newInqNo, newFormNo, old.id]);
    return nq[0];
  });
  res.json(success({
    newInquiryId: r.id,
    newInquiryNumber: r.inquiry_number,
    note: 'Student data copied into new draft inquiry',
  }));
}));

// ==========================================
// EDUCATIONAL DETAILS HANDLER
// ==========================================
const EducationalRowSchema = z.object({
  id: z.string().optional(),
  subject: z.string().min(1),
  standard: z.string().optional(),
  t1: z.union([z.string(), z.number()]).optional(),
  t2: z.union([z.string(), z.number()]).optional(),
  t3: z.union([z.string(), z.number()]).optional(),
  t4: z.union([z.string(), z.number()]).optional(),
  t5: z.union([z.string(), z.number()]).optional(),
  t1Marks: z.union([z.string(), z.number()]).optional(),
  t2Marks: z.union([z.string(), z.number()]).optional(),
  t3Marks: z.union([z.string(), z.number()]).optional(),
  t4Marks: z.union([z.string(), z.number()]).optional(),
  t5Marks: z.union([z.string(), z.number()]).optional(),
  marksAvg: z.union([z.string(), z.number()]).optional(),
});

const EducationalDetailsSchema = z.object({
  currentClass: z.string().nullish(),
  school: z.string().nullish(),
  schoolCollege: z.string().nullish(),
  board: z.string().nullish(),
  stream: z.string().nullish(),
  percentage: z.union([z.string(), z.number()]).nullish(),
  percentageOrCgpa: z.union([z.string(), z.number()]).nullish(),
  graduationYear: z.string().nullish(),
  educationBoardId: z.string().uuid().nullish(),
  performanceTable: z.array(EducationalRowSchema).optional().default([]),
  performanceRows: z.array(EducationalRowSchema).optional().default([]),
});

inquiryRoutes.post('/:id/educational-details', validate(EducationalDetailsSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  const auth = req.auth!;

  const result = await tx(async (client) => {
    const { rows: lookup } = await client.query<any>(
      `SELECT id, student_id FROM inquiries WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, auth.orgId]
    );
    if (lookup.length === 0) throw ApiError.notFound('Inquiry not found');

    const schoolName = d.schoolCollege || d.school || null;
    const streamName = d.stream || null;
    const currentClass = d.currentClass || null;
    const percentage = d.percentageOrCgpa || d.percentage || null;
    const graduationYear = d.graduationYear || null;

    const eduMeta = {
      schoolCollege: schoolName,
      stream: streamName,
      currentClass,
      percentageOrCgpa: percentage,
      graduationYear,
      educationBoardId: d.educationBoardId || null,
      board: d.board || null,
    };

    // Save extra academic details into student_preferences jsonb
    await client.query(`
      INSERT INTO student_preferences (inquiry_id, extra_fields_jsonb, created_at, updated_at)
      VALUES ($1, $2::jsonb, NOW(), NOW())
      ON CONFLICT (inquiry_id)
      DO UPDATE SET
        extra_fields_jsonb = COALESCE(student_preferences.extra_fields_jsonb, '{}'::jsonb) || $2::jsonb,
        updated_at = NOW()
    `, [id, JSON.stringify(eduMeta)]);

    // Update inquiries overall progress
    await client.query(`
      UPDATE inquiries SET
        overall_progress_percent = GREATEST(overall_progress_percent, 25),
        updated_at = NOW()
      WHERE id = $1
    `, [id]);

    // Replace performance rows
    await client.query(`DELETE FROM student_performance_rows WHERE inquiry_id = $1`, [id]);

    const inputRows = (d.performanceRows && d.performanceRows.length > 0) ? d.performanceRows : d.performanceTable;
    const insertedRows: any[] = [];

    if (Array.isArray(inputRows) && inputRows.length > 0) {
      for (let i = 0; i < inputRows.length; i++) {
        const row = inputRows[i];
        if (!row.subject || !row.subject.trim()) continue;

        const t1 = row.t1Marks ?? row.t1;
        const t2 = row.t2Marks ?? row.t2;
        const t3 = row.t3Marks ?? row.t3;
        const t4 = row.t4Marks ?? row.t4;
        const t5 = row.t5Marks ?? row.t5;

        const p1 = t1 !== undefined && t1 !== null && t1 !== '' ? parseFloat(String(t1)) : null;
        const p2 = t2 !== undefined && t2 !== null && t2 !== '' ? parseFloat(String(t2)) : null;
        const p3 = t3 !== undefined && t3 !== null && t3 !== '' ? parseFloat(String(t3)) : null;
        const p4 = t4 !== undefined && t4 !== null && t4 !== '' ? parseFloat(String(t4)) : null;
        const p5 = t5 !== undefined && t5 !== null && t5 !== '' ? parseFloat(String(t5)) : null;
        const avg = row.marksAvg !== undefined && row.marksAvg !== null && row.marksAvg !== '' ? parseFloat(String(row.marksAvg)) : null;

        const { rows: [ins] } = await client.query<any>(`
          INSERT INTO student_performance_rows (
            inquiry_id, subject_name, standard_class,
            term1_score, term2_score, term3_score, term4_score, term5_score,
            marks_average, sort_order
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `, [
          id, row.subject.trim(), row.standard || currentClass || null,
          p1, p2, p3, p4, p5, avg, i + 1,
        ]);
        insertedRows.push(ins);
      }
    }

    return {
      inquiryId: id,
      educationalDetails: eduMeta,
      performanceRows: insertedRows,
      ok: true,
      stepAdvancedTo: 1,
    };
  });

  res.json(success(result));
}));

const PreferencesSchema = z.object({
  subjectsOfInterest: z.array(z.string()).optional(),
  careerGoalsAmbition: z.string().optional(),
  challengesFaced: z.string().optional(),
  preferredLanguage: z.string().optional(),
  followUpFrequencyCode: z.enum(['3days', 'weekly', 'monthly', 'quarterly', 'yearly']).optional(),
  subjectsEasy: z.array(z.string()).optional(),
  subjectsDifficult: z.array(z.string()).optional(),
  teacherOfLiking: z.string().optional(),
  whatYouWantToBe: z.string().optional(),
  branchPreferenceCode: z.string().optional(),
  idealPersonality: z.string().optional(),
  sports: z.string().optional(),
  tvChannelHobby: z.string().optional(),
  closeRelativeInfluencer: z.string().optional(),
  awardsCertificates: z.string().optional(),
  computerCompetency: z.string().optional(),
  closeFriends: z.string().optional(),
  otherCloseRelatives: z.string().optional(),
  mobileUsageHabit: z.string().optional(),
  counsellorObservations: z.string().optional(),
});

// POST /api/v1/inquiries/:id/preferences
inquiryRoutes.post('/:id/preferences', validate(PreferencesSchema), asyncHandler(async (req, res) => {
  const inquiryId = req.params.id;
  const d = req.body;
  const auth = req.auth!;

  const { rows: [inq] } = await query<any>(
    `SELECT * FROM inquiries WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [inquiryId, auth.orgId]
  );
  if (!inq) throw ApiError.notFound('Inquiry not found');

  const { rows: [prefs] } = await query<any>(`
    INSERT INTO student_preferences (
      inquiry_id,
      subject_of_interest,
      career_goals,
      challenges_faced,
      preferred_language_detailed,
      follow_up_frequency,
      subjects_easy,
      subjects_difficult,
      teacher_of_liking,
      career_goal_what_you_want_to_be,
      branch_goal,
      ideal_personality,
      sports,
      tv_channel_of_liking,
      close_relative_particular,
      awards_certificates,
      computer_competency,
      close_friends_names,
      other_close_relatives,
      mobile_usage_which_mobile,
      counsellor_notes_observations,
      created_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW(), NOW()
    )
    ON CONFLICT (inquiry_id)
    DO UPDATE SET
      subject_of_interest = COALESCE($2, student_preferences.subject_of_interest),
      career_goals = COALESCE($3, student_preferences.career_goals),
      challenges_faced = COALESCE($4, student_preferences.challenges_faced),
      preferred_language_detailed = COALESCE($5, student_preferences.preferred_language_detailed),
      follow_up_frequency = COALESCE($6, student_preferences.follow_up_frequency),
      subjects_easy = COALESCE($7, student_preferences.subjects_easy),
      subjects_difficult = COALESCE($8, student_preferences.subjects_difficult),
      teacher_of_liking = COALESCE($9, student_preferences.teacher_of_liking),
      career_goal_what_you_want_to_be = COALESCE($10, student_preferences.career_goal_what_you_want_to_be),
      branch_goal = COALESCE($11, student_preferences.branch_goal),
      ideal_personality = COALESCE($12, student_preferences.ideal_personality),
      sports = COALESCE($13, student_preferences.sports),
      tv_channel_of_liking = COALESCE($14, student_preferences.tv_channel_of_liking),
      close_relative_particular = COALESCE($15, student_preferences.close_relative_particular),
      awards_certificates = COALESCE($16, student_preferences.awards_certificates),
      computer_competency = COALESCE($17, student_preferences.computer_competency),
      close_friends_names = COALESCE($18, student_preferences.close_friends_names),
      other_close_relatives = COALESCE($19, student_preferences.other_close_relatives),
      mobile_usage_which_mobile = COALESCE($20, student_preferences.mobile_usage_which_mobile),
      counsellor_notes_observations = COALESCE($21, student_preferences.counsellor_notes_observations),
      updated_at = NOW()
    RETURNING *
  `, [
    inquiryId,
    d.subjectsOfInterest ? d.subjectsOfInterest.join(', ') : null,
    d.careerGoalsAmbition || null,
    d.challengesFaced || null,
    d.preferredLanguage || null,
    d.followUpFrequencyCode || null,
    d.subjectsEasy ? d.subjectsEasy.join(', ') : null,
    d.subjectsDifficult ? d.subjectsDifficult.join(', ') : null,
    d.teacherOfLiking || null,
    d.whatYouWantToBe || null,
    d.branchPreferenceCode || null,
    d.idealPersonality || null,
    d.sports || null,
    d.tvChannelHobby || null,
    d.closeRelativeInfluencer || null,
    d.awardsCertificates || null,
    d.computerCompetency || null,
    d.closeFriends || null,
    d.otherCloseRelatives || null,
    d.mobileUsageHabit || null,
    d.counsellorObservations || null,
  ]);

  res.json(success(prefs));
}));

// GET /api/v1/inquiries/:id/full-dossier
inquiryRoutes.get('/:id/full-dossier', asyncHandler(async (req, res) => {
  const inquiryId = req.params.id;
  const auth = req.auth!;

  const { rows: [inq] } = await query<any>(`
    SELECT 
      i.*,
      s.full_name, s.email AS student_email, s.phone AS student_phone,
      s.date_of_birth, s.gender, s.address_line1, s.address_line2,
      s.city, s.state, s.pincode, s.photo_storage_key,
      p.name AS program_name, p.code AS program_code, p.price AS program_price,
      p.grade_range AS program_grade_range,
      b.name AS branch_name, b.code AS branch_code,
      c.full_name AS assigned_counsellor_name, c.title AS assigned_counsellor_title
    FROM inquiries i
    JOIN students s ON s.id = i.student_id
    LEFT JOIN programs p ON p.id = i.program_id
    LEFT JOIN branches b ON b.id = i.branch_id
    LEFT JOIN counsellors c ON c.id = COALESCE(i.current_counsellor_id, i.assigned_counsellor_id)
    WHERE i.id = $1 AND i.organization_id = $2 AND i.deleted_at IS NULL
  `, [inquiryId, auth.orgId]);

  if (!inq) throw ApiError.notFound('Inquiry not found');

  const { rows: parents } = await query<any>(`
    SELECT p.*, sp.is_guardian
    FROM parents p
    JOIN student_parents sp ON sp.parent_id = p.id
    WHERE sp.student_id = $1
    LIMIT 1
  `, [inq.student_id]);
  const parent = parents[0] || null;

  const { rows: perfRows } = await query<any>(`
    SELECT id, subject_name AS subject, standard_class AS standard,
           term1_score AS "t1Marks", term2_score AS "t2Marks",
           term3_score AS "t3Marks", term4_score AS "t4Marks",
           term5_score AS "t5Marks", marks_average AS "marksAvg",
           sort_order
    FROM student_performance_rows
    WHERE inquiry_id = $1
    ORDER BY sort_order ASC
  `, [inquiryId]);

  const { rows: [prefs] } = await query<any>(`
    SELECT * FROM student_preferences WHERE inquiry_id = $1
  `, [inquiryId]);

  const { rows: [apt] } = await query<any>(`
    SELECT a.*, c.full_name AS counsellor_name, c.title AS counsellor_title
    FROM appointments a
    JOIN counsellors c ON c.id = a.counsellor_id
    WHERE a.inquiry_id = $1
    ORDER BY a.appointment_date DESC, a.slot_start_time DESC
    LIMIT 1
  `, [inquiryId]);

  const { rows: [conc] } = await query<any>(`
    SELECT * FROM conclusions WHERE inquiry_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [inquiryId]);

  let actionItems: any[] = [];
  if (conc) {
    const { rows: ai } = await query<any>(`
      SELECT id, item_number, action_text, is_completed, due_date FROM action_items WHERE conclusion_id = $1 ORDER BY item_number
    `, [conc.id]);
    actionItems = ai;
  }

  const { rows: payments } = await query<any>(`
    SELECT id, receipt_number, total_amount, method, status, paid_at, razorpay_payment_id, created_at
    FROM payments WHERE inquiry_id = $1 ORDER BY created_at DESC
  `, [inquiryId]);

  const extraMeta = prefs?.extra_fields_jsonb || {};

  res.json(success({
    inquiry: {
      id: inq.id,
      inquiryNumber: inq.inquiry_number,
      registrationFormNo: inq.registration_form_no,
      status: inq.status,
      feeStatus: inq.fee_status,
      overallProgressPercent: inq.overall_progress_percent,
      program: inq.program_id ? {
        id: inq.program_id,
        name: inq.program_name,
        code: inq.program_code,
        price: inq.program_price,
        gradeRange: inq.program_grade_range,
      } : null,
      branch: inq.branch_id ? {
        id: inq.branch_id,
        name: inq.branch_name,
        code: inq.branch_code,
      } : null,
      counsellor: inq.assigned_counsellor_id ? {
        id: inq.assigned_counsellor_id,
        name: inq.assigned_counsellor_name,
        title: inq.assigned_counsellor_title,
      } : null,
      createdAt: inq.created_at,
      updatedAt: inq.updated_at,
    },
    student: {
      id: inq.student_id,
      fullName: inq.full_name,
      email: inq.student_email,
      phone: inq.student_phone,
      dateOfBirth: inq.date_of_birth,
      gender: inq.gender,
      addressLine1: inq.address_line1,
      city: inq.city,
      state: inq.state,
      pincode: inq.pincode,
      parentName: parent?.full_name || null,
      parentPhone: parent?.phone || null,
      parentOccupation: parent?.occupation || null,
      schoolCollege: extraMeta.schoolCollege || null,
      stream: extraMeta.stream || null,
      currentClass: extraMeta.currentClass || null,
      percentageOrCgpa: extraMeta.percentageOrCgpa || null,
      graduationYear: extraMeta.graduationYear || null,
    },
    performanceRows: perfRows,
    preferences: prefs ? {
      subjectsOfInterest: prefs.subject_of_interest ? prefs.subject_of_interest.split(', ') : [],
      careerGoalsAmbition: prefs.career_goals,
      challengesFaced: prefs.challenges_faced,
      preferredLanguage: prefs.preferred_language_detailed,
      followUpFrequencyCode: prefs.follow_up_frequency,
      whatYouWantToBe: prefs.career_goal_what_you_want_to_be,
      sports: prefs.sports,
    } : null,
    appointment: apt ? {
      id: apt.id,
      date: apt.appointment_date,
      time: apt.slot_time_display,
      mode: apt.mode,
      counsellorName: apt.counsellor_name,
      location: apt.location,
      status: apt.status,
    } : null,
    conclusion: conc ? {
      id: conc.id,
      summary: conc.session_summary,
      observations: conc.observations,
      recommendations: conc.recommendations,
      counsellorSignature: conc.counsellor_signature_name,
      nextFollowUp: conc.next_follow_up_scheduled,
      actionItems: actionItems.map((a: any) => ({
        id: a.id,
        itemNumber: a.item_number,
        taskTitle: a.action_text,
        isDone: a.is_completed,
      })),
      isDraft: conc.is_draft,
      finalizedAt: conc.finalized_at,
    } : null,
    payments,
  }));
}));

// ==========================================
// PATCH INQUIRY HANDLER
// ==========================================
inquiryRoutes.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const auth = req.auth!;

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.status) {
    fields.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.feeStatus) {
    fields.push(`fee_status = $${idx++}`);
    values.push(updates.feeStatus);
  }
  if (updates.overallProgressPercent !== undefined) {
    fields.push(`overall_progress_percent = $${idx++}`);
    values.push(updates.overallProgressPercent);
  }
  if (updates.assignedCounsellorId) {
    fields.push(`assigned_counsellor_id = $${idx++}`);
    values.push(updates.assignedCounsellorId);
  }

  if (fields.length > 0) {
    values.push(id, auth.orgId);
    await query(`
      UPDATE inquiries SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${idx++} AND organization_id = $${idx++}
    `, values);
  }

  res.json(success({ ok: true, id }));
}));
