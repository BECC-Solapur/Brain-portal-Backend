import { Router } from 'express';
export const paymentRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import env from '../config/env';

const CARD_PRICES: Record<string, number> = {
  ankur: 1499,
  palavi: 1999,
  lakshya: 2499,
  disha: 2999,
  udaan: 2999,
  phoenix: 3999,
  cmt: 1271,
};

function razorpayClient() {
  if (!env.razorpay.keyId || !env.razorpay.keySecret) {
    throw ApiError.internal('Razorpay Test Mode keys are not configured');
  }
  return new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
}

function signaturesMatch(actual: string, expected: string) {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

paymentRoutes.post('/razorpay/webhook', asyncHandler(async (req, res) => {
  if (!env.razorpay.webhookSecret) throw ApiError.internal('Razorpay webhook secret is not configured');
  const signature = String(req.headers['x-razorpay-signature'] || '');
  const rawBody = req.rawBody;
  if (!signature || !rawBody) {
    throw ApiError.badRequest('PAYMENT_SIGNATURE_INVALID', 'Missing Razorpay webhook signature');
  }
  const expected = crypto.createHmac('sha256', env.razorpay.webhookSecret).update(rawBody).digest('hex');
  if (!signaturesMatch(signature, expected)) {
    throw ApiError.badRequest('PAYMENT_SIGNATURE_INVALID', 'Invalid Razorpay webhook signature');
  }

  const event = req.body as any;
  if (event?.event === 'payment.captured' || event?.event === 'order.paid') {
    const paymentEntity = event?.payload?.payment?.entity;
    const orderEntity = event?.payload?.order?.entity;
    const orderId = paymentEntity?.order_id || orderEntity?.id;
    const gatewayPaymentId = paymentEntity?.id;
    if (orderId) {
      await tx(async (client) => {
        const { rows: [payment] } = await client.query<any>(
          `SELECT id, inquiry_id, status FROM payments WHERE razorpay_order_id=$1 FOR UPDATE`,
          [orderId]
        );
        if (!payment || payment.status === 'paid') return;
        await client.query(
          `UPDATE payments SET status='paid', razorpay_payment_id=COALESCE($1, razorpay_payment_id), paid_at=NOW(), gateway_reference=$2 WHERE id=$3`,
          [gatewayPaymentId || null, JSON.stringify({ eventId: event.id, event: event.event }), payment.id]
        );
        await client.query(
          `UPDATE inquiries SET status=CASE WHEN status IN ('draft','program_selected','personal_submitted') THEN 'payment_paid' ELSE status END, fee_status='paid', overall_progress_percent=GREATEST(overall_progress_percent, 50) WHERE id=$1`,
          [payment.inquiry_id]
        );
      });
    }
  }
  res.status(200).json({ ok: true });
}));

const CreateOrderSchema = z.object({
  inquiryId: z.string().min(1).optional(),
  programCode: z.enum(['ankur', 'palavi', 'lakshya', 'disha', 'udaan', 'phoenix', 'cmt']),
  installmentNumber: z.number().int().min(1).default(1),
  counsellorId: z.string().uuid().optional().nullable(),
  counsellorName: z.string().optional().nullable(),
  appointmentDate: z.string().optional().nullable(),
  slotTime: z.string().optional().nullable(),
});

paymentRoutes.post('/razorpay/create-order', requireAuth(), validate(CreateOrderSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth;
  const orgId = auth?.orgId || '00000000-0000-0000-0000-000000000001';
  const userId = auth?.userId || null;

  const isCmt = d.programCode === 'cmt';
  const programFee = isCmt ? 1271 : (CARD_PRICES[d.programCode] || 2499);
  const gst = isCmt ? 229 : Math.round(programFee * 0.18);
  const grandTotal = programFee + gst;
  const amountInPaise = grandTotal * 100;
  const receiptNo = 'RCP-' + Date.now().toString().slice(-10);

  const order = await razorpayClient().orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: receiptNo,
    notes: {
      programCode: d.programCode,
      requestedInquiryId: d.inquiryId || '',
      counsellorId: d.counsellorId || '',
      counsellorName: d.counsellorName || '',
      appointmentDate: d.appointmentDate || '',
      slotTime: d.slotTime || '',
    },
  });

  const result = await tx(async (client) => {
    let inq: any = null;
    let student: any = null;

    const { rows: branchRows } = await client.query<any>(
      `SELECT id FROM branches WHERE organization_id = $1 AND is_active = TRUE ORDER BY created_at LIMIT 1`,
      [orgId]
    );
    const branchId = branchRows[0]?.id || '00000000-0000-0000-0000-000000000001';

    if (d.inquiryId) {
      const { rows } = await client.query<any>(`
        SELECT i.*, s.full_name, s.email, s.phone
        FROM inquiries i
        JOIN students s ON s.id = i.student_id
        WHERE i.id::text = $1 OR i.inquiry_number = $1
        LIMIT 1
      `, [d.inquiryId]);
      if (rows[0]) inq = rows[0];
    }

    if (!inq && userId) {
      const { rows } = await client.query<any>(`
        SELECT i.*, s.full_name, s.email, s.phone
        FROM inquiries i
        JOIN students s ON s.id = i.student_id
        WHERE s.user_id = $1
        ORDER BY i.created_at DESC
        LIMIT 1
      `, [userId]);
      if (rows[0]) inq = rows[0];

      if (!inq) {
        const { rows: studentRows } = await client.query<any>(`
          SELECT id, organization_id, branch_id, full_name, email, phone
          FROM students
          WHERE user_id = $1 AND deleted_at IS NULL AND is_active = TRUE
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId]);
        if (studentRows[0]) student = studentRows[0];
      }
    }

    const { rows: [program] } = await client.query<any>(
      `SELECT id FROM programs
       WHERE organization_id=$2 AND LOWER(code)=LOWER($1) AND is_active=TRUE
       LIMIT 1`,
      [d.programCode, orgId]
    );

    if (!program) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'The selected counselling module is not configured.');
    }

    // Resolve target counsellor (user selected or fallback to active primary counsellor)
    let targetCounsellorId = d.counsellorId || null;
    if (!targetCounsellorId) {
      const { rows: [defC] } = await client.query<any>(`
        SELECT id FROM counsellors WHERE deleted_at IS NULL AND is_active = TRUE ORDER BY created_at ASC LIMIT 1
      `);
      if (defC) targetCounsellorId = defC.id;
    }

    if (!inq) {
      if (!student) {
        const regNo = 'STU-' + Date.now().toString().slice(-8);
        const { rows: [createdStudent] } = await client.query<any>(`
          INSERT INTO students (organization_id, branch_id, user_id, full_name, email, phone, registration_number, gender, is_active)
          VALUES ($1, $2, $3, 'Counselling Student', 'student@brain.edu', '9876543210', $4, 'not_specified', TRUE)
          RETURNING id, organization_id, branch_id, full_name, email, phone
        `, [orgId, branchId, userId, regNo]);
        student = createdStudent;
      }

      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const seq = Math.floor(100000 + Math.random() * 900000);
      const inqNo = `BRAIN-${ymd}-${seq}`;
      const formNo = `FRM-${ymd}-${seq}`;

      const { rows: [newInq] } = await client.query<any>(`
        INSERT INTO inquiries (
          organization_id, branch_id, student_id, program_id,
          current_counsellor_id, assigned_counsellor_id,
          inquiry_number, registration_form_no, form_date, overall_progress_percent
        ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, CURRENT_DATE, 0)
        RETURNING *
      `, [student.organization_id || orgId, student.branch_id || branchId, student.id, program?.id || null, targetCounsellorId, inqNo, formNo]);

      inq = { ...newInq, full_name: student.full_name, email: student.email, phone: student.phone };
    } else {
      await client.query(`
        UPDATE inquiries 
        SET program_id = COALESCE($1, program_id),
            current_counsellor_id = COALESCE($2, current_counsellor_id),
            assigned_counsellor_id = COALESCE($2, assigned_counsellor_id),
            updated_at = NOW()
        WHERE id = $3
      `, [program?.id || null, targetCounsellorId, inq.id]);
      inq.program_id = program?.id || inq.program_id;
    }

    // Check if a payment for this inquiry & installment already exists
    const { rows: existingRows } = await client.query<any>(`
      SELECT id, status, total_amount, razorpay_order_id, receipt_number
      FROM payments
      WHERE inquiry_id = $1 AND direction = 'collection' AND installment_number = $2
      ORDER BY created_at DESC
      FOR UPDATE
    `, [inq.id, d.installmentNumber]);

    const alreadyPaid = existingRows.find((p: any) => p.status === 'paid');
    if (alreadyPaid) {
      throw ApiError.badRequest('PAYMENT_ALREADY_PAID', 'This installment has already been paid and verified.');
    }

    let pay: any;
    const pendingOrFailed = existingRows[0];

    if (pendingOrFailed) {
      // Reuse / update the existing pending or failed payment row
      const { rows: [updatedPay] } = await client.query<any>(`
        UPDATE payments SET
          receipt_number = $1,
          method = 'razorpay_upi',
          status = 'pending',
          currency = 'INR',
          program_fee_amount = $2,
          service_fee_amount = 0,
          gst_amount = $3,
          round_off_adjustment_amount = 0,
          total_amount = $4,
          subtotal_before_discount = $4,
          discount_amount_applied = 0,
          total_after_discount = $4,
          razorpay_order_id = $5,
          gateway_reference = $6,
          created_by = COALESCE(created_by, $7),
          updated_at = NOW()
        WHERE id = $8
        RETURNING id, receipt_number, total_amount
      `, [
        receiptNo,
        programFee, gst, grandTotal,
        order.id, JSON.stringify({ orderId: order.id, status: order.status }),
        userId,
        pendingOrFailed.id,
      ]);
      pay = updatedPay;
    } else {
      const { rows: [createdPay] } = await client.query<any>(`
        INSERT INTO payments (
          organization_id, inquiry_id, student_id, branch_id,
          installment_number, receipt_number,
          method, status, direction,
          currency,
          program_fee_amount, service_fee_amount, gst_amount,
          round_off_adjustment_amount, total_amount,
          subtotal_before_discount, discount_amount_applied, total_after_discount,
          referral_code_id, referral_code_text_snapshot,
          discount_type_snapshot, discount_value_snapshot,
          razorpay_order_id, gateway_reference,
          paid_at, created_by
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6,
          'razorpay_upi', 'pending', 'collection',
          'INR',
          $7, 0, $8,
          0, $9,
          $9, 0, $9,
          NULL, NULL,
          NULL, NULL,
          $10, $11,
          NULL, $12
        ) RETURNING id, receipt_number, total_amount
      `, [
        inq.organization_id || orgId, inq.id, inq.student_id, inq.branch_id || branchId,
        d.installmentNumber, receiptNo,
        programFee, gst, grandTotal,
        order.id, JSON.stringify({ orderId: order.id, status: order.status }),
        userId,
      ]);
      pay = createdPay;
    }

    return {
      razorpayOrderId: order.id,
      razorpayKeyId: env.razorpay.keyId,
      amount: amountInPaise,
      currency: 'INR',
      receipt: receiptNo,
      inquiryId: inq.id,
      paymentId: pay.id,
      prefill: { name: inq.full_name || 'Student', email: inq.email || '', contact: inq.phone || '' },
      programFeeAmount: programFee,
      serviceFeeAmount: 0,
      gstAmount: gst,
      discountAmountApplied: 0,
      roundOffAdjustmentAmount: 0,
      grandTotal,
      subtotalBeforeDiscount: grandTotal,
      status: order.status,
    };
  });

  res.json(success(result));
}));

const VerifySchema = z.object({
  razorpayPaymentId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpaySignature: z.string().min(1),
  inquiryId: z.string().uuid(),
  paymentMethodSnapshot: z.enum(['razorpay_upi', 'razorpay_card', 'razorpay_netbanking', 'razorpay_wallet']).optional(),
});

paymentRoutes.post('/razorpay/verify', requireAuth(), validate(VerifySchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth;
  const result = await tx(async (client) => {
    const { rows: [pay] } = await client.query<any>(`
      SELECT p.*, i.student_id, i.branch_id FROM payments p
       JOIN inquiries i ON i.id = p.inquiry_id
      WHERE p.razorpay_order_id = $1 AND p.inquiry_id = $2
      ORDER BY p.created_at DESC LIMIT 1
    `, [d.razorpayOrderId, d.inquiryId]);
    if (!pay) throw ApiError.notFound('Payment order not found');

    const expectedSig = crypto
      .createHmac('sha256', env.razorpay.keySecret)
      .update(`${pay.razorpay_order_id}|${d.razorpayPaymentId}`)
      .digest('hex');
    if (!signaturesMatch(d.razorpaySignature.trim(), expectedSig)) {
      throw ApiError.badRequest('PAYMENT_SIGNATURE_INVALID', 'Razorpay signature mismatch');
    }

    const gatewayPayment = await razorpayClient().payments.fetch(d.razorpayPaymentId);
    if (gatewayPayment.order_id !== pay.razorpay_order_id || Number(gatewayPayment.amount) !== Math.round(Number(pay.total_amount) * 100)) {
      throw ApiError.badRequest('PAYMENT_AMOUNT_MISMATCH', 'Razorpay payment does not match the stored order');
    }
    if (gatewayPayment.status === 'authorized') {
      await razorpayClient().payments.capture(d.razorpayPaymentId, Number(gatewayPayment.amount), gatewayPayment.currency);
    } else if (gatewayPayment.status !== 'captured') {
      throw ApiError.badRequest('PAYMENT_AMOUNT_MISMATCH', `Payment is not captured (status: ${gatewayPayment.status})`);
    }

    const paidAt = new Date().toISOString();
    await client.query(`
      UPDATE payments SET
        status = 'paid', razorpay_payment_id = $1, paid_at = NOW(),
        method = COALESCE($2::payment_method_enum, method),
        razorpay_signature = $3, gateway_reference = COALESCE(gateway_reference, '{}')
      WHERE id = $4
    `, [d.razorpayPaymentId, d.paymentMethodSnapshot || null, d.razorpaySignature, pay.id]);

    await client.query(`
      UPDATE inquiries SET
        status = CASE WHEN status IN ('draft','program_selected','personal_submitted') THEN 'payment_paid' ELSE status END,
        fee_status = 'paid',
        overall_progress_percent = GREATEST(overall_progress_percent, 50)
      WHERE id = $1
    `, [d.inquiryId]);

    // Ensure inquiry is mapped to counsellor and appointment record is created
    const gatewayNotes = (gatewayPayment.notes || {}) as Record<string, string>;
    const noteCounsellorId = gatewayNotes.counsellorId || null;
    if (noteCounsellorId) {
      await client.query(`
        UPDATE inquiries 
        SET current_counsellor_id = COALESCE(current_counsellor_id, $1),
            assigned_counsellor_id = COALESCE(assigned_counsellor_id, $1)
        WHERE id = $2
      `, [noteCounsellorId, d.inquiryId]);
    }

    const { rows: [inqRow] } = await client.query<any>(`
      SELECT i.*, s.id as stu_id, s.full_name as stu_name 
      FROM inquiries i 
      JOIN students s ON s.id = i.student_id 
      WHERE i.id = $1
    `, [d.inquiryId]);

    const activeCounsellorId = inqRow?.current_counsellor_id || inqRow?.assigned_counsellor_id || noteCounsellorId;
    if (inqRow && activeCounsellorId) {
      const apptDate = gatewayNotes.appointmentDate || new Date().toISOString().slice(0, 10);
      const slotTime = gatewayNotes.slotTime || '10:00 AM';

      const { rows: existingAppt } = await client.query<any>(`
        SELECT id FROM appointments WHERE inquiry_id = $1 LIMIT 1
      `, [d.inquiryId]);

      if (existingAppt.length === 0) {
        const [timePart, period] = slotTime.split(' ');
        const [h, m] = (timePart || '10:00').split(':').map(Number);
        let startH = h || 10;
        if (period === 'PM' && startH < 12) startH += 12;
        if (period === 'AM' && startH === 12) startH = 0;
        const endH = (startH + 1) % 24;
        const startTimeStr = `${String(startH).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`;
        const endTimeStr = `${String(endH).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`;

        await client.query(`
          INSERT INTO appointments (
            organization_id, inquiry_id, branch_id, counsellor_id,
            appointment_date, slot_start_time, slot_end_time, slot_time_display,
            mode, status, is_primary, location, booked_by, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4,
            $5::date, $6::time, $7::time, $8,
            'in_person', 'booked', TRUE, 'BRAIN Counselling Center · Pune Campus', $9, NOW(), NOW()
          )
          ON CONFLICT DO NOTHING
        `, [
          inqRow.organization_id, inqRow.id, inqRow.branch_id, activeCounsellorId,
          apptDate, startTimeStr, endTimeStr, `${slotTime} – 45 min session`,
          auth?.userId || null
        ]);

        await client.query(`
          UPDATE inquiries 
          SET status = 'appointment_booked', 
              overall_progress_percent = GREATEST(overall_progress_percent, 60)
          WHERE id = $1
        `, [inqRow.id]);
      }
    }

    let counters: any = null;
    if (pay.referral_code_id) {
      const { rows: [rc] } = await client.query<any>(`
        UPDATE referral_codes SET
          current_usage_count = current_usage_count + 1,
          paid_conversions_count = paid_conversions_count + 1,
          total_discount_given_amount = total_discount_given_amount + $1,
          total_revenue_generated_amount = total_revenue_generated_amount + $2,
          unique_students_used_count = unique_students_used_count + 1
        WHERE id = $3
        RETURNING current_usage_count, paid_conversions_count, total_revenue_generated_amount
      `, [parseFloat(pay.discount_amount_applied || 0), parseFloat(pay.total_amount || 0), pay.referral_code_id]);
      counters = rc[0] ? {
        currentUsageCount: parseInt(rc[0].current_usage_count),
        paidConversionsCount: parseInt(rc[0].paid_conversions_count),
        totalRevenueGeneratedAmount: parseFloat(rc[0].total_revenue_generated_amount),
      } : null;
    }

    return {
      paymentId: pay.id,
      status: 'paid' as const,
      receiptNumber: pay.receipt_number,
      paidAt,
      totalAmount: parseFloat(pay.total_amount),
      nextStep: { required: 'BOOK_APPOINTMENT', inquiryStep: 4 } as const,
      referralDiscountApplied: {
        codeText: pay.referral_code_text_snapshot || null,
        discountAmount: parseFloat(pay.discount_amount_applied || 0),
        updatedReferralCounters: counters,
      },
    };
  });

  res.json(success(result));
}));

paymentRoutes.use(requireAuth());

const OfflineSchema = z.object({
  inquiryId: z.string().uuid(),
  method: z.enum(['cash', 'bank_transfer', 'cheque', 'dd', 'other']),
  instrumentReferenceNo: z.string().nullish(),
  instrumentDate: z.string().nullish(),
  instrumentBankName: z.string().nullish(),
  depositedIntoAccount: z.string().nullish(),
  amount: z.number().positive(),
  paymentDate: z.string(),
  referralCodeId: z.string().uuid().nullish(),
  subtotalBeforeDiscount: z.number().nonnegative().default(0),
  discountAmountApplied: z.number().nonnegative().default(0),
  totalAfterDiscount: z.number().nonnegative(),
  notes: z.string().nullish(),
});

paymentRoutes.post('/offline/record', validate(OfflineSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;
  const receiptNo = 'RCP-OFF-' + Date.now().toString().slice(-10);
  let methodEnum: string = d.method;
  if (!['cash', 'bank_transfer', 'cheque', 'dd', 'other'].includes(d.method)) methodEnum = 'other';

  const { rows: ins } = await query<any>(`
    INSERT INTO payments (
      organization_id, inquiry_id, student_id, branch_id,
      receipt_number, method, status, direction, currency,
      program_fee_amount, service_fee_amount, gst_amount,
      subtotal_before_discount, discount_amount_applied,
      total_after_discount, round_off_adjustment_amount, total_amount,
      referral_code_id,
      instrument_reference_no, instrument_date, instrument_bank_name,
      deposited_into_account, paid_at, created_by
    ) SELECT
        i.organization_id, i.id, i.student_id, i.branch_id,
        $2, $3::payment_method_enum, 'paid', 'collection', 'INR',
        COALESCE(pr.price, 0), 0, 0,
        $4, $5, $6, 0, $7,
        $8,
        $9, $10::DATE, $11, $12,
        $13::DATE, NOW(), $14
      FROM inquiries i
      LEFT JOIN programs pr ON pr.id = i.program_id
      WHERE i.id = $1
      RETURNING id, receipt_number, total_amount
  `, [d.inquiryId, receiptNo, methodEnum,
  d.subtotalBeforeDiscount, d.discountAmountApplied, d.totalAfterDiscount, d.amount,
  d.referralCodeId || null,
  d.instrumentReferenceNo || null, d.instrumentDate || null, d.instrumentBankName || null,
  d.depositedIntoAccount || null, d.paymentDate, auth.userId]);

  await query(
    `UPDATE inquiries SET status='payment_paid', fee_status='paid',
     overall_progress_percent = GREATEST(overall_progress_percent, 50) WHERE id=$1`,
    [d.inquiryId]
  );
  res.status(201).json(success({ paymentId: ins[0].id, receiptNumber: ins[0].receipt_number, status: 'paid', totalAmount: parseFloat(ins[0].total_amount) }));
}));

paymentRoutes.get('/inquiry/:inquiryId', asyncHandler(async (req, res) => {
  const { rows } = await query<any>(`
    SELECT id, status, method, total_amount, paid_at, failure_at, razorpay_payment_id,
           receipt_number, referral_code_text_snapshot, discount_amount_applied,
           subtotal_before_discount, total_after_discount, program_fee_amount,
           service_fee_amount, gst_amount, round_off_adjustment_amount, currency,
           created_at
    FROM payments
    WHERE inquiry_id = $1
    ORDER BY created_at DESC
  `, [req.params.inquiryId]);
  res.json(success(rows.map(r => ({
    id: r.id,
    status: r.status,
    method: r.method,
    totalAmount: parseFloat(r.total_amount || 0),
    programFeeAmount: parseFloat(r.program_fee_amount || 0),
    serviceFeeAmount: parseFloat(r.service_fee_amount || 0),
    gstAmount: parseFloat(r.gst_amount || 0),
    roundOffAdjustmentAmount: parseFloat(r.round_off_adjustment_amount || 0),
    subtotalBeforeDiscount: parseFloat(r.subtotal_before_discount || 0),
    discountAmountApplied: parseFloat(r.discount_amount_applied || 0),
    totalAfterDiscount: parseFloat(r.total_after_discount || 0),
    currency: r.currency || 'INR',
    paidAt: r.paid_at,
    failureAt: r.failure_at,
    razorpayPaymentId: r.razorpay_payment_id,
    receiptNumber: r.receipt_number,
    referralCodeTextSnapshot: r.referral_code_text_snapshot,
    createdAt: r.created_at,
  }))));
}));

paymentRoutes.get('/:id/details', asyncHandler(async (req, res) => {
  const { rows } = await query<any>(
    `SELECT * FROM payments WHERE id = $1`,
    [req.params.id]);
  res.json(success(rows[0] || null));
}));

// GET /api/v1/payments/ledger - Full organization payment transactions ledger
paymentRoutes.get('/ledger', asyncHandler(async (req, res) => {
  const { status, method, branchId, search, dateFrom, dateTo } = req.query as {
    status?: string;
    method?: string;
    branchId?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  };

  let sql = `
    SELECT 
      p.id,
      p.receipt_number,
      p.inquiry_id,
      p.method,
      p.status,
      p.direction,
      p.currency,
      p.program_fee_amount,
      p.service_fee_amount,
      p.gst_amount,
      p.subtotal_before_discount,
      p.discount_amount_applied,
      p.total_after_discount,
      p.round_off_adjustment_amount,
      p.total_amount,
      p.referral_code_text_snapshot,
      p.razorpay_payment_id,
      p.instrument_reference_no,
      p.instrument_bank_name,
      p.paid_at,
      p.created_at,
      i.inquiry_number,
      s.full_name AS student_name,
      s.email AS student_email,
      s.phone AS student_phone,
      pr.name AS program_name,
      pr.code AS program_code,
      b.name AS branch_name
    FROM payments p
    LEFT JOIN inquiries i ON i.id = p.inquiry_id
    LEFT JOIN students s ON s.id = p.student_id
    LEFT JOIN programs pr ON pr.id = i.program_id
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE 1=1
  `;
  const params: any[] = [];
  let pIdx = 1;

  if (status && status !== 'all') {
    sql += ` AND p.status = $${pIdx++}`;
    params.push(status);
  }
  if (method && method !== 'all') {
    sql += ` AND p.method = $${pIdx++}::payment_method_enum`;
    params.push(method);
  }
  if (branchId) {
    sql += ` AND p.branch_id = $${pIdx++}`;
    params.push(branchId);
  }
  if (dateFrom) {
    sql += ` AND p.created_at >= $${pIdx++}::TIMESTAMP`;
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ` AND p.created_at <= $${pIdx++}::TIMESTAMP`;
    params.push(dateTo);
  }
  if (search) {
    sql += ` AND (p.receipt_number ILIKE $${pIdx} OR s.full_name ILIKE $${pIdx} OR s.phone ILIKE $${pIdx} OR i.inquiry_number ILIKE $${pIdx})`;
    params.push(`%${search}%`);
    pIdx++;
  }

  sql += ` ORDER BY p.created_at DESC`;

  const { rows } = await query<any>(sql, params);

  // Compute aggregate financial summary
  const { rows: [metrics] } = await query<any>(`
    SELECT 
      COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0)::numeric AS total_revenue,
      COALESCE(SUM(discount_amount_applied) FILTER (WHERE status = 'paid'), 0)::numeric AS total_discount,
      COALESCE(SUM(gst_amount) FILTER (WHERE status = 'paid'), 0)::numeric AS total_gst,
      COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
    FROM payments
  `);

  const ledger = rows.map(r => ({
    id: r.id,
    receiptNumber: r.receipt_number,
    inquiryId: r.inquiry_id,
    inquiryNumber: r.inquiry_number,
    studentName: r.student_name,
    studentEmail: r.student_email,
    studentPhone: r.student_phone,
    programName: r.program_name,
    programCode: r.program_code,
    branchName: r.branch_name,
    method: r.method,
    status: r.status,
    direction: r.direction,
    currency: r.currency || 'INR',
    programFeeAmount: parseFloat(r.program_fee_amount || 0),
    serviceFeeAmount: parseFloat(r.service_fee_amount || 0),
    gstAmount: parseFloat(r.gst_amount || 0),
    subtotalBeforeDiscount: parseFloat(r.subtotal_before_discount || 0),
    discountAmountApplied: parseFloat(r.discount_amount_applied || 0),
    totalAfterDiscount: parseFloat(r.total_after_discount || 0),
    totalAmount: parseFloat(r.total_amount || 0),
    referralCode: r.referral_code_text_snapshot,
    razorpayPaymentId: r.razorpay_payment_id,
    instrumentReferenceNo: r.instrument_reference_no,
    instrumentBankName: r.instrument_bank_name,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  }));

  res.json(success({
    ledger,
    summary: {
      totalRevenue: parseFloat(metrics?.total_revenue || 0),
      totalDiscountGiven: parseFloat(metrics?.total_discount || 0),
      totalGstCollected: parseFloat(metrics?.total_gst || 0),
      paidCount: metrics?.paid_count || 0,
      pendingCount: metrics?.pending_count || 0,
      failedCount: metrics?.failed_count || 0,
    }
  }));
}));
