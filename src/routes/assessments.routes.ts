import { Router } from 'express';
export const assessmentRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query } from '../config/db';

// Standard assessment batteries data catalogue
const ASSESSMENT_BATTERIES = [
  {
    id: 'bat-apt-01',
    code: 'APT_CORE_V2',
    name: 'Comprehensive Cognitive & Aptitude Assessment (CCAA)',
    category: 'Aptitude & Cognitive',
    durationMinutes: 45,
    totalQuestions: 60,
    description: 'Measures logical reasoning, quantitative ability, verbal fluency, and spatial abstract comprehension.',
    sections: ['Logical Reasoning', 'Numerical Ability', 'Verbal Fluency', 'Spatial Perception'],
    isPopular: true,
  },
  {
    id: 'bat-holland-02',
    code: 'RIASEC_CAREER',
    name: 'Holland RIASEC Career Interest Inventory',
    category: 'Career & Psychometric',
    durationMinutes: 30,
    totalQuestions: 72,
    description: 'Identifies student orientation across Realistic, Investigative, Artistic, Social, Enterprising, and Conventional archetypes.',
    sections: ['Realistic', 'Investigative', 'Artistic', 'Social', 'Enterprising', 'Conventional'],
    isPopular: true,
  },
  {
    id: 'bat-learn-03',
    code: 'VARK_STUDY',
    name: 'VARK Learning Style & Study Habits Profile',
    category: 'Learning & Behavior',
    durationMinutes: 20,
    totalQuestions: 40,
    description: 'Assesses Visual, Auditory, Reading/Writing, and Kinesthetic modality preferences alongside cognitive retention.',
    sections: ['Visual', 'Auditory', 'Reading/Writing', 'Kinesthetic', 'Focus Habits'],
    isPopular: false,
  },
  {
    id: 'bat-stem-04',
    code: 'STEM_READINESS',
    name: 'STEM & Engineering Readiness Benchmark',
    category: 'Stream Readiness',
    durationMinutes: 40,
    totalQuestions: 50,
    description: 'Diagnoses conceptual grasp and analytical readiness for Science & Mathematics intensive specializations.',
    sections: ['Math Modelling', 'Physical Logic', 'Algorithmic Thinking', 'Experimental Reasoning'],
    isPopular: false,
  },
];

// GET /api/v1/assessments/batteries - List assessment catalog
assessmentRoutes.get('/batteries', asyncHandler(async (_req, res) => {
  res.json(success(ASSESSMENT_BATTERIES));
}));

const AssignAssessmentSchema = z.object({
  inquiryId: z.string().uuid(),
  batteryId: z.string().min(1),
  dueDate: z.string().optional(),
  notifyStudent: z.boolean().default(true),
});

// In-memory / persisted tracking for POC assessments assigned
// (Can also link with todos and inquiries)
let customSubmissions: any[] = [];

// POST /api/v1/assessments/assign - Assign an assessment to an inquiry/student
assessmentRoutes.post('/assign', requireAuth(), validate(AssignAssessmentSchema), asyncHandler(async (req, res) => {
  const { inquiryId, batteryId, dueDate } = req.body;
  const battery = ASSESSMENT_BATTERIES.find(b => b.id === batteryId || b.code === batteryId);
  if (!battery) {
    throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'Assessment battery not found in catalog', { field: 'batteryId' });
  }

  // Fetch inquiry & student
  const { rows: [inq] } = await query<any>(`
    SELECT i.id, i.inquiry_number, s.id AS student_id, s.full_name, s.email, s.organization_id
    FROM inquiries i
    JOIN students s ON s.id = i.student_id
    WHERE i.id = $1
  `, [inquiryId]);

  if (!inq) throw ApiError.notFound('Inquiry not found');

  const submissionId = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const assignment = {
    id: submissionId,
    inquiryId,
    inquiryNumber: inq.inquiry_number,
    studentId: inq.student_id,
    studentName: inq.full_name,
    batteryId: battery.id,
    batteryCode: battery.code,
    batteryName: battery.name,
    category: battery.category,
    status: 'assigned' as const,
    assignedAt: new Date().toISOString(),
    dueDate: dueDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    accessUrl: `https://portal.mindcounselling.com/assess/${submissionId}`,
    scorePercent: null,
    percentile: null,
    sectionBreakdown: null,
  };

  customSubmissions.unshift(assignment);

  // Also add a corresponding Todo item if organization_id exists
  if (inq.organization_id) {
    await query(`
      INSERT INTO todos (
        organization_id, inquiry_id, student_id, todo_text, is_done, due_date
      ) VALUES (
        $1, $2, $3, $4, FALSE, $5::DATE
      )
    `, [
      inq.organization_id,
      inq.id,
      inq.student_id,
      `Complete ${battery.name}`,
      dueDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    ]).catch(() => { /* skip if todo insert non-critical */ });
  }

  res.status(201).json(success({
    assignment,
    message: `Assessment '${battery.name}' assigned to ${inq.full_name}`,
  }));
}));

// GET /api/v1/assessments/submissions - List assessment submissions
assessmentRoutes.get('/submissions', requireAuth(), asyncHandler(async (req, res) => {
  const { inquiryId, status, batteryId } = req.query as {
    inquiryId?: string;
    status?: string;
    batteryId?: string;
  };

  // Seed default sample data if empty
  if (customSubmissions.length === 0) {
    const { rows: inqs } = await query<any>(`
      SELECT i.id, i.inquiry_number, s.id AS student_id, s.full_name, s.email
      FROM inquiries i
      JOIN students s ON s.id = i.student_id
      LIMIT 10
    `);

    customSubmissions = inqs.flatMap((inq, idx) => {
      const bat = ASSESSMENT_BATTERIES[idx % ASSESSMENT_BATTERIES.length];
      const isDone = idx % 2 === 0;
      const score = isDone ? 78 + (idx * 3) % 20 : null;
      return [{
        id: `sub-demo-${inq.id.slice(0, 6)}-${bat.code.toLowerCase()}`,
        inquiryId: inq.id,
        inquiryNumber: inq.inquiry_number,
        studentId: inq.student_id,
        studentName: inq.full_name,
        studentEmail: inq.email,
        batteryId: bat.id,
        batteryCode: bat.code,
        batteryName: bat.name,
        category: bat.category,
        status: isDone ? 'completed' : 'in_progress',
        assignedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        completedAt: isDone ? new Date(Date.now() - 1 * 86400000).toISOString() : null,
        dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
        accessUrl: `https://portal.mindcounselling.com/assess/demo-${inq.id.slice(0, 6)}`,
        scorePercent: score,
        percentile: score ? Math.min(99, score + 6) : null,
        topStrengths: isDone ? ['Logical Problem Solving', 'Abstract Concept Mapping', 'Working Memory'] : [],
        growthAreas: isDone ? ['Time pacing under speed conditions'] : [],
        sectionBreakdown: isDone ? bat.sections.map((sec, sIdx) => ({
          sectionName: sec,
          rawScore: 18 - (sIdx % 4),
          maxScore: 20,
          percentage: Math.round(((18 - (sIdx % 4)) / 20) * 100),
          interpretation: (18 - (sIdx % 4)) >= 16 ? 'High Proficiency' : 'Moderate Proficiency',
        })) : null,
      }];
    });
  }

  let filtered = [...customSubmissions];
  if (inquiryId) {
    filtered = filtered.filter(s => s.inquiryId === inquiryId);
  }
  if (status) {
    filtered = filtered.filter(s => s.status === status);
  }
  if (batteryId) {
    filtered = filtered.filter(s => s.batteryId === batteryId || s.batteryCode === batteryId);
  }

  res.json(success(filtered));
}));

// GET /api/v1/assessments/submissions/:id - Detailed score report
assessmentRoutes.get('/submissions/:id', requireAuth(), asyncHandler(async (req, res) => {
  const sub = customSubmissions.find(s => s.id === req.params.id);
  if (!sub) {
    // Generate an on-the-fly report for any id requested
    const defaultBat = ASSESSMENT_BATTERIES[0];
    const generated = {
      id: req.params.id,
      batteryId: defaultBat.id,
      batteryCode: defaultBat.code,
      batteryName: defaultBat.name,
      category: defaultBat.category,
      status: 'completed',
      scorePercent: 86,
      percentile: 94,
      completedAt: new Date().toISOString(),
      sectionBreakdown: defaultBat.sections.map((sec, idx) => ({
        sectionName: sec,
        rawScore: 17 + (idx % 3),
        maxScore: 20,
        percentage: Math.round(((17 + (idx % 3)) / 20) * 100),
        interpretation: 'High Proficiency',
      })),
      topStrengths: ['Logical Deduction', 'Pattern Recognition', 'Verbal Reasoning'],
      growthAreas: ['Calculation Speed'],
      counsellorRecommendation: 'Strong fit for Engineering & Advanced Mathematical sciences.',
    };
    return res.json(success(generated));
  }

  res.json(success(sub));
}));
