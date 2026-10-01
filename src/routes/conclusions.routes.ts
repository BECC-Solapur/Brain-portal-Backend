import { Router } from 'express';
export const conclusionRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query, tx } from '../config/db';

conclusionRoutes.use(requireAuth());

const CreateConclusionSchema = z.object({
  inquiryId: z.string().uuid(),
  summary: z.string().optional(),
  sessionSummary: z.string().optional(),
  observations: z.string().min(2),
  recommendations: z.string().min(2),
  counsellorSignature: z.string().optional(),
  counsellorSignatureName: z.string().optional(),
});

conclusionRoutes.post('/', validate(CreateConclusionSchema), asyncHandler(async (req, res) => {
  const d = req.body;
  const auth = req.auth!;

  const summaryText = d.summary || d.sessionSummary;
  if (!summaryText) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Session summary is required', { field: 'sessionSummary' });
  }
  const signature = d.counsellorSignature || d.counsellorSignatureName || 'Counsellor';
  const result = await tx(async (client) => {
    const { rows: [inq] } = await client.query<any>(
      `SELECT id, organization_id, assigned_counsellor_id, student_id FROM inquiries WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [d.inquiryId, auth.orgId]
    );
    if (!inq) throw ApiError.notFound('Inquiry not found');

    const { rows: [session] } = await client.query<any>(`
      SELECT id
      FROM counselling_sessions
      WHERE inquiry_id = $1 AND organization_id = $2
      ORDER BY COALESCE(session_ended_at, session_started_at, created_at) DESC NULLS LAST
      LIMIT 1
    `, [d.inquiryId, auth.orgId]);
    if (!session) {
      throw ApiError.badRequest(
        'INPUT_VALIDATION_FAILED',
        'Complete or start a counselling session before publishing its conclusion'
      );
    }

    let counsellorId = inq.assigned_counsellor_id;
    if (!counsellorId) {
      const { rows: cRows } = await client.query<any>(
        `SELECT id FROM counsellors WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [auth.orgId]
      );
      counsellorId = cRows[0]?.id;
    }
    if (!counsellorId) {
      const { rows: anyC } = await client.query<any>(`SELECT id FROM counsellors LIMIT 1`);
      counsellorId = anyC[0]?.id;
    }
    if (!counsellorId) {
      const { rows: [newC] } = await client.query<any>(`
        INSERT INTO counsellors (organization_id, full_name, title, is_active)
        VALUES ($1, $2, 'Senior Educational Counsellor', TRUE)
        RETURNING id
      `, [auth.orgId, signature]);
      counsellorId = newC.id;
    }

    // Insert or update conclusion
    const { rows: [conc] } = await client.query<any>(`
      INSERT INTO conclusions (
        organization_id, session_id, inquiry_id, student_id, counsellor_id, version_no, conclusion_date,
        session_summary, observations, recommendations,
        counsellor_signature_name,
        is_draft, finalized_at, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        (SELECT COALESCE(MAX(version_no), 0) + 1 FROM conclusions WHERE session_id = $2),
        CURRENT_DATE,
        $6, $7, $8,
        $9, $10, $11, $12
      )
      RETURNING id, inquiry_id, conclusion_date, session_summary, observations, recommendations,
                counsellor_signature_name,
                is_draft, finalized_at, created_at
    `, [
      auth.orgId, session.id, d.inquiryId, inq.student_id, counsellorId,
      summaryText, d.observations, d.recommendations,
      signature, false, new Date(), auth.userId
    ]);

    // Publishing a conclusion completes the inquiry; this endpoint does not
    // create drafts, action items, todos, or follow-up schedules.
    await client.query(`
      UPDATE inquiries SET
        status = 'completed'::inquiry_status_enum,
        overall_progress_percent = 100,
        completed_at = NOW()
      WHERE id = $1
    `, [d.inquiryId]);

    return {
      conclusion: {
        id: conc.id,
        inquiryId: conc.inquiry_id,
        counsellorId: counsellorId,
        conclusionDate: conc.conclusion_date,
        sessionSummary: conc.session_summary,
        observations: conc.observations,
        recommendations: conc.recommendations,
        nextFollowUpScheduled: null,
        followUpFrequencyCode: null,
        counsellorSignatureName: conc.counsellor_signature_name,
        isDraftVersion: conc.is_draft,
        finalizedAt: conc.finalized_at,
        actionItems: [],
        createdAt: conc.created_at,
      },
      message: 'Conclusion saved successfully',
    };
  });

  res.status(201).json(success(result));
}));

conclusionRoutes.get('/:inquiryId', asyncHandler(async (req, res) => {
  const { inquiryId } = req.params;
  const auth = req.auth!;

  const { rows: [conc] } = await query<any>(`
    SELECT c.*, inq.inquiry_number, inq.registration_form_no,
           s.full_name AS student_name, s.phone AS student_phone, s.email AS student_email,
           p.name AS program_name, p.grade_range
    FROM conclusions c
    JOIN inquiries inq ON inq.id = c.inquiry_id
    JOIN students s ON s.id = inq.student_id
    LEFT JOIN programs p ON p.id = inq.program_id
    WHERE c.inquiry_id = $1 AND c.organization_id = $2
    ORDER BY c.created_at DESC LIMIT 1
  `, [inquiryId, auth.orgId]);

  if (!conc) throw ApiError.notFound('Conclusion dossier not found');

  const { rows: ai } = await query<any>(`
    SELECT id, item_number, action_text, is_completed, due_date
    FROM action_items WHERE conclusion_id = $1 ORDER BY item_number
  `, [conc.id]);

  res.json(success({
    id: conc.id,
    inquiryId: conc.inquiry_id,
    inquiryNumber: conc.inquiry_number,
    studentName: conc.student_name,
    studentPhone: conc.student_phone,
    programName: conc.program_name,
    gradeRange: conc.grade_range,
    conclusionDate: conc.conclusion_date,
    summary: conc.session_summary,
    observations: conc.observations,
    recommendations: conc.recommendations,
    counsellorSignature: conc.counsellor_signature_name,
    isDraft: conc.is_draft,
    isDraftVersion: conc.is_draft,
    actionItems: ai.map((item: any) => ({
      id: item.id,
      itemNumber: item.item_number,
      taskTitle: item.action_text,
      text: item.action_text,
      isCompleted: item.is_completed,
      isDone: item.is_completed,
      dueDate: item.due_date,
    })),
    createdAt: conc.created_at,
  }));
}));

conclusionRoutes.patch('/:id/finalize', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const auth = req.auth!;

  const { rows: [updated] } = await query<any>(`
    UPDATE conclusions
    SET is_draft = FALSE, finalized_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND organization_id = $2
    RETURNING *
  `, [id, auth.orgId]);

  if (!updated) throw ApiError.notFound('Conclusion not found');

  res.json(success({
    conclusion: {
      id: updated.id,
      inquiryId: updated.inquiry_id,
      isDraftVersion: false,
      finalizedAt: updated.finalized_at,
    },
    message: 'Conclusion finalized successfully',
  }));
}));
