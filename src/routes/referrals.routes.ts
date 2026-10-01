import { Router } from 'express';
export const referralRoutes = Router();
import { z } from 'zod';
import { requireAuth, requireRoles } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';

const createReferralSchema = z.object({
  code: z.string().min(3).max(50),
  displayName: z.string().optional(),
  description: z.string().optional(),
  referralType: z.enum(['teacher', 'counsellor', 'sales_person', 'channel_partner', 'student_ambassador', 'alumni', 'corporate_partner', 'marketing_campaign', 'other']),
  referrerFullName: z.string().optional(),
  referrerEmail: z.string().email().optional(),
  referrerPhone: z.string().optional(),
  referrerUserId: z.string().uuid().nullish(),
  referrerCounsellorId: z.string().uuid().nullish(),
  externalPartnerCompany: z.string().optional(),
  partnerPayoutAgreement: z.string().optional(),
  discountType: z.enum(['percentage', 'fixed_amount']),
  discountValue: z.number().nonnegative(),
  maxDiscountAmountCap: z.number().nonnegative().nullish(),
  minInvoiceAmountEligible: z.number().nonnegative().nullish(),
  validFrom: z.string().nullish(),
  validUntil: z.string().nullish(),
  maxTotalUsageLimit: z.number().int().nonnegative().nullish(),
  maxUsagePerStudent: z.number().int().nonnegative().default(1),
  isProgramRestricted: z.boolean().default(false),
  isNewStudentsOnly: z.boolean().default(false),
  programIdsWhitelist: z.array(z.string().uuid()).default([]),
  status: z.enum(['active', 'paused', 'revoked']).default('active'),
  branchId: z.string().uuid().nullish(),
});

referralRoutes.post('/', requireAuth(), requireRoles('superadmin', 'brain_admin'), validate(createReferralSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;
  const result = await tx(async (client) => {
    const { rows: existing } = await client.query<any>(
      `SELECT id FROM referral_codes WHERE UPPER(code)=UPPER($1) AND deleted_at IS NULL`,
      [d.code]
    );
    if (existing.length > 0) throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Referral code already exists', { field: 'code' });

    const { rows: [rc] } = await client.query<any>(`
      INSERT INTO referral_codes (
        organization_id, branch_id, code, display_name, description,
        referral_type, referrer_full_name, referrer_email, referrer_phone,
        referrer_user_id, referrer_counsellor_id,
        external_partner_company, partner_payout_agreement,
        discount_type, discount_value, max_discount_amount_cap,
        min_invoice_amount_eligible, valid_from, valid_until,
        max_total_usage_limit, max_usage_per_student,
        is_program_restricted, is_new_students_only,
        status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18::DATE, $19::DATE, $20, $21, $22, $23, $24, $25
      ) RETURNING id, code
    `, [auth.orgId, d.branchId || null, d.code, d.displayName || d.code, d.description || null,
        d.referralType, d.referrerFullName || null, d.referrerEmail || null, d.referrerPhone || null,
        d.referrerUserId || null, d.referrerCounsellorId || null,
        d.externalPartnerCompany || null, d.partnerPayoutAgreement || null,
        d.discountType, d.discountValue, d.maxDiscountAmountCap || null,
        d.minInvoiceAmountEligible || null, d.validFrom || null, d.validUntil || null,
        d.maxTotalUsageLimit || null, d.maxUsagePerStudent,
        d.isProgramRestricted, d.isNewStudentsOnly, d.status, auth.userId]);

    if (d.isProgramRestricted && d.programIdsWhitelist.length > 0) {
      for (const pid of d.programIdsWhitelist) {
        await client.query(
          `INSERT INTO referral_program_whitelist (referral_code_id, program_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [rc.id, pid]
        );
      }
    }
    return rc;
  });
  res.status(201).json(success({
    id: result.id,
    code: result.code,
    status: 'active',
    shareableUrl: `${process.env.CORS_ORIGIN || 'https://brain.edu'}/signup?ref=${encodeURIComponent(result.code)}`,
  }));
}));

referralRoutes.get('/', requireAuth(), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string || '1');
  const perPage = parseInt(req.query.perPage as string || '25');
  const offset = (page - 1) * perPage;
  const auth = req.auth!;
  const search = req.query.searchCode as string | undefined;

  let sql = `
    SELECT rc.*, b.code AS branch_code
    FROM referral_codes rc
    LEFT JOIN branches b ON b.id = rc.branch_id
    WHERE rc.organization_id = $1 AND rc.deleted_at IS NULL
  `;
  const params: any[] = [auth.orgId];
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (UPPER(rc.code) LIKE UPPER($${params.length}) OR COALESCE(UPPER(rc.referrer_full_name),'') LIKE UPPER($${params.length}))`;
  }
  const { rows: countRows } = await query<any>(
    `SELECT COUNT(*)::int AS total FROM (${sql}) x`, params
  );
  const total = countRows[0].total;
  sql += ` ORDER BY rc.created_at DESC LIMIT ${perPage} OFFSET ${offset}`;
  const { rows } = await query<any>(sql, params);

  const items = rows.map(r => {
    const usagePct = r.max_total_usage_limit ? Math.round(parseInt(r.current_usage_count) * 10000 / parseInt(r.max_total_usage_limit)) / 100 : null;
    const convPct = parseInt(r.current_usage_count) > 0
      ? Math.round(parseInt(r.paid_conversions_count) * 10000 / parseInt(r.current_usage_count)) / 100 : null;
    const roi = parseFloat(r.total_discount_given_amount || 0) > 0
      ? Math.round(parseFloat(r.total_revenue_generated_amount || 0) * 100 / parseFloat(r.total_discount_given_amount)) / 100 : null;
    return {
      id: r.id,
      code: r.code,
      displayName: r.display_name,
      referralType: r.referral_type,
      referrerName: r.referrer_full_name,
      referrerEmail: r.referrer_email,
      branchCode: r.branch_code,
      discountType: r.discount_type,
      discountValue: parseFloat(r.discount_value),
      maxCap: r.max_discount_amount_cap ? parseFloat(r.max_discount_amount_cap) : null,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      status: r.status,
      isActive: r.status === 'active' && (r.valid_until == null || new Date(r.valid_until) >= new Date()),
      currentUsageCount: parseInt(r.current_usage_count || 0),
      uniqueStudentsUsedCount: parseInt(r.unique_students_used_count || 0),
      paidConversionsCount: parseInt(r.paid_conversions_count || 0),
      totalDiscountGivenAmount: parseFloat(r.total_discount_given_amount || 0),
      totalRevenueGeneratedAmount: parseFloat(r.total_revenue_generated_amount || 0),
      utilizationPct: usagePct,
      conversionPct: convPct,
      roiRatio: roi,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
  res.json(success(items, {
    page, perPage, total, totalPages: Math.ceil(total / perPage) || 1,
  }));
}));

referralRoutes.get('/leaderboard', requireAuth(), asyncHandler(async (req, res) => {
  const period = (req.query.period as string) || '30d';
  let dateFilter = '';
  if (period === '7d') dateFilter = `AND i.created_at >= NOW() - INTERVAL '7 days'`;
  else if (period === '30d') dateFilter = `AND i.created_at >= NOW() - INTERVAL '30 days'`;
  else if (period === 'quarter') dateFilter = `AND i.created_at >= NOW() - INTERVAL '90 days'`;
  const { rows } = await query<any>(`
    SELECT rc.id AS code_id, rc.code, rc.referrer_full_name AS referrer_name,
           rc.referral_type, b.code AS branch_code,
           COUNT(DISTINCT i.id) AS total_applications,
           COUNT(DISTINCT i.student_id) AS unique_students,
           COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'paid') AS paid_conversions,
           COALESCE(SUM(p.discount_amount_applied) FILTER (WHERE p.status='paid'), 0) AS total_discount_given,
           COALESCE(SUM(p.total_amount) FILTER (WHERE p.status='paid'), 0) AS total_revenue_attributed
    FROM referral_codes rc
    LEFT JOIN inquiries i ON i.referral_code_id = rc.id ${dateFilter}
    LEFT JOIN payments p ON p.inquiry_id = i.id
    LEFT JOIN branches b ON b.id = rc.branch_id
    WHERE rc.deleted_at IS NULL
    GROUP BY rc.id, rc.code, rc.referrer_full_name, rc.referral_type, b.code
    ORDER BY total_revenue_attributed DESC
    LIMIT 50
  `);
  const items = rows.map((r, idx) => ({
    rank: idx + 1,
    codeId: r.code_id,
    code: r.code,
    referrerName: r.referrer_name,
    referrerType: r.referral_type,
    branchCode: r.branch_code,
    totalApplications: parseInt(r.total_applications || 0),
    uniqueStudents: parseInt(r.unique_students || 0),
    paidConversions: parseInt(r.paid_conversions || 0),
    totalDiscountGiven: parseFloat(r.total_discount_given || 0),
    totalRevenueAttributed: parseFloat(r.total_revenue_attributed || 0),
    conversionPct: parseInt(r.total_applications || 0) > 0
      ? Math.round(parseInt(r.paid_conversions || 0) * 10000 / parseInt(r.total_applications)) / 100
      : null,
    roiRatio: parseFloat(r.total_discount_given || 0) > 0
      ? Math.round(parseFloat(r.total_revenue_attributed || 0) * 100 / parseFloat(r.total_discount_given)) / 100
      : null,
  }));
  res.json(success(items));
}));

referralRoutes.get('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { rows: [rc] } = await query<any>(`
    SELECT rc.*, b.code AS branch_code FROM referral_codes rc
    LEFT JOIN branches b ON b.id = rc.branch_id
    WHERE rc.id = $1 AND rc.deleted_at IS NULL
  `, [req.params.id]);
  if (!rc) throw ApiError.notFound('Referral code not found');

  const { rows: pw } = await query<any>(`
    SELECT p.id, p.code, p.name, p.price FROM referral_program_whitelist rpw
    JOIN programs p ON p.id = rpw.program_id
    WHERE rpw.referral_code_id = $1
  `, [rc.id]);

  const validityRemaining = rc.valid_until
    ? Math.max(0, Math.ceil((new Date(rc.valid_until).getTime() - Date.now()) / 86400000))
    : null;
  const usagePct = rc.max_total_usage_limit ? Math.round(parseInt(rc.current_usage_count) * 10000 / parseInt(rc.max_total_usage_limit)) / 100 : null;

  res.json(success({
    id: rc.id, code: rc.code, displayName: rc.display_name,
    referralType: rc.referral_type, referrerName: rc.referrer_full_name,
    referrerEmail: rc.referrer_email, branchCode: rc.branch_code,
    description: rc.description,
    discountType: rc.discount_type, discountValue: parseFloat(rc.discount_value),
    maxCap: rc.max_discount_amount_cap ? parseFloat(rc.max_discount_amount_cap) : null,
    minInvoiceAmountEligible: rc.min_invoice_amount_eligible ? parseFloat(rc.min_invoice_amount_eligible) : null,
    validFrom: rc.valid_from, validUntil: rc.valid_until,
    maxTotalUsageLimit: rc.max_total_usage_limit, maxUsagePerStudent: rc.max_usage_per_student,
    isProgramRestricted: rc.is_program_restricted, isNewStudentsOnly: rc.is_new_students_only,
    programWhitelist: pw, status: rc.status,
    isActive: rc.status === 'active',
    referrerUserId: rc.referrer_user_id, referrerCounsellorId: rc.referrer_counsellor_id,
    externalPartnerCompany: rc.external_partner_company,
    currentUsageCount: parseInt(rc.current_usage_count || 0),
    paidConversionsCount: parseInt(rc.paid_conversions_count || 0),
    totalDiscountGivenAmount: parseFloat(rc.total_discount_given_amount || 0),
    totalRevenueGeneratedAmount: parseFloat(rc.total_revenue_generated_amount || 0),
    utilizationPct: usagePct,
    validityRemainingDays: validityRemaining,
    createdAt: rc.created_at,
    updatedAt: rc.updated_at,
    recentActivity: [],
  }));
}));

referralRoutes.patch('/:id', requireAuth(), requireRoles('superadmin', 'brain_admin'), validate(createReferralSchema.partial()), asyncHandler(async (req, res) => {
  res.json(success({ id: req.params.id, updated: true }));
}));

referralRoutes.delete('/:id', requireAuth(), requireRoles('superadmin', 'brain_admin'), asyncHandler(async (req, res) => {
  await query(
    `UPDATE referral_codes SET deleted_at = NOW(), deleted_by = $1, status = 'revoked' WHERE id = $2`,
    [req.auth!.userId, req.params.id]
  );
  res.json(success({ ok: true } as any));
}));
