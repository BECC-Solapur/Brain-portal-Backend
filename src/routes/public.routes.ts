import { Router } from 'express';
export const publicRoutes = Router();
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncHandler, success, PaisaOrINR, UUID } from '../types/api';
import { query } from '../config/db';

interface ProgramPublic {
  id: UUID;
  code: string;
  name: string;
  tagline: string;
  gradeRange: string;
  description: string;
  features: string[];
  price: PaisaOrINR;
  currency: 'INR';
  gradientCssClasses: string;
  iconName: string;
  isActive: boolean;
}

publicRoutes.get('/programs', asyncHandler(async (_req, res) => {
  const { rows } = await query<any>(`
    SELECT p.id, p.code, p.name, p.tagline, p.grade_range, p.description,
           p.price, p.gradient_classes, p.icon_name, p.is_active
    FROM programs p
    WHERE p.is_active = TRUE
    ORDER BY p.sort_order
  `);
  const programs: ProgramPublic[] = await Promise.all(rows.map(async (r) => {
    const { rows: fr } = await query<any>(
      `SELECT feature_text FROM program_features WHERE program_id = $1 ORDER BY sort_order`,
      [r.id]
    );
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      tagline: r.tagline,
      gradeRange: r.grade_range,
      description: r.description,
      features: fr.map((f: any) => f.feature_text),
      price: parseFloat(r.price),
      currency: 'INR' as 'INR',
      gradientCssClasses: r.gradient_classes || '',
      iconName: r.icon_name || '',
      isActive: r.is_active,
    };
  }));
  res.json(success(programs));
}));

publicRoutes.get('/stats', asyncHandler(async (_req, res) => {
  const { rows: s } = await query<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE deleted_at IS NULL) AS students_counselled,
      (SELECT COUNT(*)::int FROM inquiries WHERE status = 'completed') AS completed,
      (SELECT COUNT(*)::int FROM inquiries) AS total
  `);
  const { rows: cr } = await query<any>(`
    SELECT COUNT(DISTINCT id)::int AS n FROM counsellors WHERE deleted_at IS NULL AND is_active = TRUE
  `);
  const { rows: ct } = await query<any>(`
    SELECT COUNT(DISTINCT city)::int AS n FROM branches WHERE is_active = TRUE
  `);
  const stat = s[0];
  const successRate = stat.total > 0
    ? Math.round((stat.completed / stat.total) * 1000) / 10
    : 0;
  res.json(success({
    studentsCounselled: stat.students_counselled,
    successRatePct: successRate,
    yearsOfExcellence: 8,
    citiesServed: ct[0]?.n || 2,
    expertCounsellors: cr[0]?.n || 5,
    averageRating: 4.8,
  }));
}));

const ReferralValidateSchema = z.object({
  codeText: z.string().min(2),
  programCode: z.string().optional(),
  subtotal: z.coerce.number().nonnegative().optional(),
});

publicRoutes.post('/referrals/validate', validate(ReferralValidateSchema), asyncHandler(async (req, res) => {
  const { codeText, programCode, subtotal } = req.body;

  const { rows } = await query<any>(`
    SELECT rc.id, rc.code, rc.display_name, rc.referral_type, rc.referrer_full_name,
           rc.discount_type, rc.discount_value, rc.max_discount_amount_cap,
           rc.valid_from, rc.valid_until, rc.max_total_usage_limit,
           rc.current_usage_count, rc.max_usage_per_student, rc.is_program_restricted,
           rc.is_new_students_only, rc.status, rc.min_invoice_amount_eligible
    FROM referral_codes rc
    WHERE UPPER(rc.code) = UPPER($1) AND rc.deleted_at IS NULL
    LIMIT 1
  `, [codeText]);

  if (rows.length === 0) {
    return res.json(success({
      isValid: false,
      errorCode: 'REFERRAL_CODE_INVALID',
      errorMessage: 'Referral code not found',
    }));
  }
  const rc = rows[0];

  const errors: { code: string; msg: string }[] = [];
  if (rc.status !== 'active') errors.push({ code: 'REFERRAL_CODE_INVALID', msg: `Code status is "${rc.status}"` });
  if (rc.valid_until && new Date(rc.valid_until) < new Date()) errors.push({ code: 'REFERRAL_CODE_EXPIRED', msg: 'Code expired' });
  if (rc.max_total_usage_limit != null && rc.current_usage_count >= rc.max_total_usage_limit) {
    errors.push({ code: 'REFERRAL_CODE_USED_UP', msg: 'Max usage reached' });
  }
  if (rc.min_invoice_amount_eligible != null && subtotal != null && subtotal < parseFloat(rc.min_invoice_amount_eligible)) {
    errors.push({ code: 'REFERRAL_CODE_NOT_ELIGIBLE_PROGRAM', msg: `Minimum invoice amount ₹${rc.min_invoice_amount_eligible} required` });
  }
  if (rc.is_program_restricted && programCode) {
    const { rows: pw } = await query<any>(`
      SELECT 1 FROM referral_program_whitelist rpw
      JOIN programs p ON p.id = rpw.program_id
      WHERE rpw.referral_code_id = $1 AND p.code = $2 AND p.deleted_at IS NULL
    `, [rc.id, programCode]);
    if (pw.length === 0) errors.push({ code: 'REFERRAL_CODE_NOT_ELIGIBLE_PROGRAM', msg: 'Code not valid for selected program' });
  }

  let discountPreviewAmount = 0;
  if (subtotal != null && errors.length === 0) {
    const dv = parseFloat(rc.discount_value);
    const maxCap = rc.max_discount_amount_cap ? parseFloat(rc.max_discount_amount_cap) : null;
    if (rc.discount_type === 'percentage') {
      discountPreviewAmount = Math.min(
        maxCap ?? Infinity,
        Math.round((subtotal * dv) / 100 * 100) / 100
      );
    } else {
      discountPreviewAmount = Math.min(
        maxCap ?? dv,
        dv
      );
    }
  }

  const validityDays = rc.valid_until
    ? Math.max(0, Math.ceil((new Date(rc.valid_until).getTime() - Date.now()) / 86400000))
    : null;
  const usagesRemaining = rc.max_total_usage_limit != null
    ? Math.max(0, rc.max_total_usage_limit - rc.current_usage_count)
    : null;

  if (errors.length > 0) {
    return res.json(success({
      isValid: false,
      codeId: rc.id,
      displayCode: rc.code,
      displayName: rc.display_name,
      referrerName: rc.referrer_full_name,
      errorCode: errors[0].code,
      errorMessage: errors[0].msg,
    }));
  }

  res.json(success({
    isValid: true,
    codeId: rc.id,
    displayCode: rc.code,
    displayName: rc.display_name,
    referrerName: rc.referrer_full_name,
    referralType: rc.referral_type,
    discountType: rc.discount_type,
    discountValue: parseFloat(rc.discount_value),
    maxCap: rc.max_discount_amount_cap ? parseFloat(rc.max_discount_amount_cap) : null,
    discountPreviewAmount,
    validityRemainingDays: validityDays,
    usagesRemaining,
    isNewStudentsOnly: rc.is_new_students_only,
  }));
}));
