import { Router } from 'express';
export const authRoutes = Router();
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, success, ApiError } from '../types/api';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, randomJti } from '../utils/auth';
import { query, tx } from '../config/db';

const LoginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

authRoutes.post('/login/password', validate(LoginPasswordSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const { rows: users } = await query<any>(`
    SELECT u.id, u.email, u.phone, u.password_hash, u.full_name, u.display_name,
           u.avatar_storage_key, u.organization_id, u.status, u.is_active,
           u.last_login_at, u.email_verified_at, u.deleted_at
    FROM users u
    WHERE LOWER(u.email::text) = LOWER($1::text) AND u.deleted_at IS NULL AND u.is_active = TRUE
    LIMIT 1
  `, [email]);

  if (users.length === 0) {
    throw ApiError.badRequest('AUTH_UNAUTHENTICATED', 'Invalid email or password');
  }
  const user = users[0];
  if (user.status !== 'active') {
    throw ApiError.badRequest('AUTH_UNAUTHENTICATED', `Account is ${user.status}`);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw ApiError.badRequest('AUTH_UNAUTHENTICATED', 'Invalid email or password');
  }

  const { rows: roleRows } = await query<any>(`
    SELECT DISTINCT r.code AS role_code
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
  `, [user.id]);
  const roles = roleRows.map(r => r.role_code);
  const rolePriority = ['superadmin', 'Super Admin', 'brain_admin', 'Brain Admin', 'counsellor', 'parent', 'student'];
  const primaryRole = rolePriority.find(r => roles.includes(r)) || roles[0] || 'student';

  const { rows: permRows } = await query<any>(`
    SELECT DISTINCT p.code AS perm_code
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = $1
  `, [user.id]);
  const permissions = permRows.map(r => r.perm_code);

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.organization_id,
    branchId: null,
    roles,
    primaryRole,
    permissions,
  });
  const jti = randomJti();
  const refreshToken = signRefreshToken(user.id, jti);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { rows: identityRows } = await query<any>(`
    SELECT
      (SELECT s.id FROM students s WHERE s.user_id = $1 AND s.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS student_id,
      (SELECT p.id FROM parents p WHERE p.user_id = $1 AND p.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS parent_id,
      (SELECT c.id FROM counsellors c WHERE c.user_id = $1 AND c.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS counsellor_id
  `, [user.id]);
  const identity = identityRows[0] || {};

  res.json(success({
    accessToken,
    refreshToken,
    expiresAt,
    user: {
      id: user.id,
      organizationId: user.organization_id,
      branchId: null,
      firstName: user.full_name.split(' ')[0],
      lastName: user.full_name.split(' ').slice(1).join(' ') || '',
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatar_storage_key,
      roles,
      primaryRole,
      permissions,
      studentId: identity.student_id,
      parentId: identity.parent_id,
      counsellorId: identity.counsellor_id,
    },
  }));
}));

const StudentSignupSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
  address: z.string().trim().min(3).max(500).optional(),
  schoolCollegeName: z.string().trim().min(2).max(255).optional(),
  password: z.string().min(6).optional(),
});

authRoutes.post('/signup/student', validate(StudentSignupSchema), asyncHandler(async (req, res) => {
  const { fullName, phone, email, address, schoolCollegeName, password } = req.body;

  const result = await tx(async (client) => {
    const { rows: orgRows } = await client.query(
      `SELECT id FROM organizations WHERE is_active = TRUE ORDER BY created_at LIMIT 1`
    );
    if (orgRows.length === 0) throw ApiError.internal('No organization seeded');
    const organizationId = orgRows[0].id;

    const { rows: branchRows } = await client.query(
      `SELECT id, code FROM branches WHERE is_active = TRUE ORDER BY created_at LIMIT 1`
    );
    const branch = branchRows[0] || null;
    const branchId = branch?.id || null;

    const { rows: existing } = await client.query(
      `SELECT id, deleted_at FROM users WHERE LOWER(email::text) = LOWER($1::text) AND organization_id = $2`,
      [email, organizationId]
    );
    if (existing.length > 0 && !existing[0].deleted_at) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'An account with this email already exists', { field: 'email' });
    }

    const pwHash = password ? await hashPassword(password) : await hashPassword(crypto.randomUUID());

    const { rows: userRows } = await client.query<any>(`
      INSERT INTO users (organization_id, email, phone, password_hash, full_name, display_name, status, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', TRUE)
      RETURNING id, organization_id, email, phone, full_name
    `, [organizationId, email.toLowerCase(), phone, pwHash, fullName, fullName]);
    const user = userRows[0];

    const { rows: roleRows } = await client.query<any>(
      `SELECT id FROM roles WHERE code = 'student' LIMIT 1`
    );
    if (roleRows.length > 0) {
      await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [user.id, roleRows[0].id]);
    }

    const { rows: [temporaryStudent] } = await client.query<any>(`
      SELECT id FROM students
      WHERE organization_id = $1 AND user_id IS NULL AND registration_status = 'temporary'
        AND (LOWER(email) = LOWER($2) OR ($3::text IS NOT NULL AND phone = $3))
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `, [organizationId, email, phone || null]);

    let studentId: string;
    if (temporaryStudent) {
      const { rows: [claimedStudent] } = await client.query<any>(`
        UPDATE students
        SET user_id = $1, branch_id = COALESCE(branch_id, $2), full_name = $3,
            email = $4, phone = COALESCE($5, phone),
            address_line1 = COALESCE($6, address_line1),
            school_college_name = COALESCE($7, school_college_name), updated_at = NOW()
        WHERE id = $8
        RETURNING id
      `, [user.id, branchId, fullName, email.toLowerCase(), phone || null,
        address || null, schoolCollegeName || null, temporaryStudent.id]);
      studentId = claimedStudent.id;
    } else {
      const regNo = 'STU-' + Date.now().toString().slice(-8);
      const { rows: studentRows } = await client.query<any>(`
        INSERT INTO students (organization_id, branch_id, user_id, full_name, email, phone,
                              registration_number, gender, address_line1, school_college_name, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_specified', $8, $9, TRUE)
        RETURNING id
      `, [organizationId, branchId, user.id, fullName, email.toLowerCase(), phone, regNo,
        address || null, schoolCollegeName || null]);
      studentId = studentRows[0].id;
    }
    return { user, studentId, roles: ['student'], primaryRole: 'student', permissions: [] as string[] };
  });

  const accessToken = signAccessToken({
    sub: result.user.id,
    orgId: result.user.organization_id,
    branchId: null,
    roles: result.roles,
    primaryRole: result.primaryRole,
    permissions: result.permissions,
  });
  const jti = randomJti();
  const refreshToken = signRefreshToken(result.user.id, jti);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  res.status(201).json(success({
    accessToken,
    refreshToken,
    expiresAt,
    studentId: result.studentId,
    user: {
      id: result.user.id,
      organizationId: result.user.organization_id,
      branchId: null,
      firstName: result.user.full_name.split(' ')[0],
      lastName: result.user.full_name.split(' ').slice(1).join(' ') || '',
      email: result.user.email,
      phone: result.user.phone,
      avatarUrl: null,
      roles: result.roles,
      primaryRole: result.primaryRole,
      permissions: result.permissions,
      studentId: result.studentId,
      parentId: null,
      counsellorId: null,
    },
  }));
}));

const ParentSignupSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email(),
  address: z.string().trim().min(3).max(500).optional(),
  studentId: z.string().trim().min(1, 'Student ID is required'),
  password: z.string().min(6).optional(),
});

authRoutes.post('/signup/parent', validate(ParentSignupSchema), asyncHandler(async (req, res) => {
  const { fullName, phone, email, address, studentId, password } = req.body;

  const result = await tx(async (client) => {
    const { rows: orgRows } = await client.query(
      `SELECT id FROM organizations WHERE is_active = TRUE ORDER BY created_at LIMIT 1`
    );
    if (orgRows.length === 0) throw ApiError.internal('No organization seeded');
    const organizationId = orgRows[0].id;

    const { rows: existing } = await client.query(
      `SELECT id, deleted_at FROM users WHERE LOWER(email::text) = LOWER($1::text) AND organization_id = $2`,
      [email, organizationId]
    );
    if (existing.length > 0 && !existing[0].deleted_at) {
      throw ApiError.badRequest('INPUT_VALIDATION_FAILED', 'An account with this email already exists', { field: 'email' });
    }

    const cleanStudentId = studentId.trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanStudentId);
    const { rows: studentRows } = isUuid
      ? await client.query<any>(
          `SELECT id, organization_id, full_name, registration_number FROM students WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [cleanStudentId]
        )
      : await client.query<any>(
          `SELECT id, organization_id, full_name, registration_number FROM students WHERE (LOWER(registration_number) = LOWER($1) OR id::text = $1) AND deleted_at IS NULL LIMIT 1`,
          [cleanStudentId]
        );

    if (studentRows.length === 0) {
      throw ApiError.badRequest(
        'INPUT_VALIDATION_FAILED',
        `No student found with Student ID / Registration Number "${cleanStudentId}". Please verify your child's Student ID.`,
        { field: 'studentId' }
      );
    }
    const targetStudent = studentRows[0];

    const pwHash = password ? await hashPassword(password) : await hashPassword(crypto.randomUUID());

    const { rows: userRows } = await client.query<any>(`
      INSERT INTO users (organization_id, email, phone, password_hash, full_name, display_name, status, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', TRUE)
      RETURNING id, organization_id, email, phone, full_name
    `, [organizationId, email.toLowerCase(), phone, pwHash, fullName, fullName]);
    const user = userRows[0];

    const { rows: roleRows } = await client.query<any>(
      `SELECT id FROM roles WHERE code = 'parent' LIMIT 1`
    );
    if (roleRows.length > 0) {
      await client.query(`
        INSERT INTO user_roles (user_id, role_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [user.id, roleRows[0].id]);
    }

    const { rows: parentRows } = await client.query<any>(`
      INSERT INTO parents (organization_id, user_id, full_name, email, phone, relationship_to_student, is_active)
      VALUES ($1, $2, $3, $4, $5, 'parent', TRUE)
      RETURNING id
    `, [organizationId, user.id, fullName, email.toLowerCase(), phone]);
    const parentId = parentRows[0].id;

    await client.query(`
      INSERT INTO student_parents (student_id, parent_id, is_guardian, is_primary_contact, can_view_progress, can_receive_notifications)
      VALUES ($1, $2, TRUE, TRUE, TRUE, TRUE)
      ON CONFLICT DO NOTHING
    `, [targetStudent.id, parentId]);

    return {
      user,
      parentId,
      studentId: targetStudent.id,
      roles: ['parent'],
      primaryRole: 'parent',
      permissions: [] as string[]
    };
  });

  const accessToken = signAccessToken({
    sub: result.user.id,
    orgId: result.user.organization_id,
    branchId: null,
    roles: result.roles,
    primaryRole: result.primaryRole,
    permissions: result.permissions,
  });
  const jti = randomJti();
  const refreshToken = signRefreshToken(result.user.id, jti);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  res.status(201).json(success({
    accessToken,
    refreshToken,
    expiresAt,
    parentId: result.parentId,
    studentId: result.studentId,
    user: {
      id: result.user.id,
      organizationId: result.user.organization_id,
      branchId: null,
      firstName: result.user.full_name.split(' ')[0],
      lastName: result.user.full_name.split(' ').slice(1).join(' ') || '',
      email: result.user.email,
      phone: result.user.phone,
      avatarUrl: null,
      roles: result.roles,
      primaryRole: result.primaryRole,
      permissions: result.permissions,
      studentId: result.studentId,
      parentId: result.parentId,
      counsellorId: null,
    },
  }));
}));

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

authRoutes.post('/refresh', validate(RefreshSchema), asyncHandler(async (req, res) => {
  res.json(success({
    accessToken: signAccessToken({
      sub: '00000000-0000-0000-0000-000000000000',
      orgId: '00000000-0000-0000-0000-000000000000',
      branchId: null,
      roles: ['student'],
      primaryRole: 'student',
      permissions: [],
    }),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));
}));

authRoutes.post('/logout', asyncHandler(async (_req, res) => {
  res.json(success({ ok: true } as any));
}));

authRoutes.get('/me', requireAuth(), asyncHandler(async (req, res) => {
  if (!req.auth) throw ApiError.unauthenticated();
  const { rows } = await query<any>(`
    SELECT id, email, phone, full_name, display_name, avatar_storage_key, avatar_url,
           organization_id, status, is_active
    FROM users WHERE id = $1
  `, [req.auth.userId]);
  if (rows.length === 0) throw ApiError.notFound('User not found');
  const u = rows[0];
  const { rows: ids } = await query<any>(`
    SELECT
      s.id AS student_id,
      s.registration_number,
      s.photo_url AS student_photo_url,
      s.photo_storage_key AS student_photo_storage_key,
      s.school_college_name,
      s.address_line1,
      (SELECT p.id FROM parents p WHERE p.user_id = $1 AND p.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS parent_id,
      (SELECT c.id FROM counsellors c WHERE c.user_id = $1 AND c.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS counsellor_id,
      (
        SELECT json_build_object(
          'id', c.id,
          'fullName', c.full_name,
          'email', c.email,
          'phone', c.phone,
          'title', c.title
        )
        FROM inquiries inq
        JOIN counsellors c ON c.id = COALESCE(inq.current_counsellor_id, inq.assigned_counsellor_id)
        WHERE inq.student_id = s.id AND inq.deleted_at IS NULL
        ORDER BY inq.created_at DESC
        LIMIT 1
      ) AS assigned_counsellor,
      EXISTS(
        SELECT 1 FROM student_parents sp
        JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = s.id AND p.deleted_at IS NULL
      ) AS parent_connected,
      (
        SELECT json_build_object(
          'id', p.id,
          'fullName', p.full_name,
          'phone', p.phone,
          'email', p.email,
          'relationship', p.relationship_to_student
        )
        FROM student_parents sp
        JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = s.id AND p.deleted_at IS NULL
        LIMIT 1
      ) AS connected_parent
    FROM (SELECT 1) _
    LEFT JOIN students s ON s.user_id = $1 AND s.deleted_at IS NULL
    ORDER BY s.created_at DESC NULLS LAST
    LIMIT 1
  `, [req.auth.userId]);

  const studentInfo = ids[0] || {};
  const photoUrl = u.avatar_url || u.avatar_storage_key || studentInfo.student_photo_url || studentInfo.student_photo_storage_key || null;

  res.json(success({
    id: u.id,
    organizationId: u.organization_id,
    branchId: null,
    firstName: u.full_name.split(' ')[0],
    lastName: u.full_name.split(' ').slice(1).join(' ') || '',
    email: u.email,
    phone: u.phone,
    avatarUrl: photoUrl,
    photoUrl: photoUrl,
    roles: req.auth.roles,
    primaryRole: req.auth.primaryRole,
    permissions: req.auth.permissions,
    studentId: studentInfo.student_id ?? null,
    registrationNumber: studentInfo.registration_number ?? null,
    schoolCollegeName: studentInfo.school_college_name ?? null,
    address: studentInfo.address_line1 ?? null,
    parentConnected: Boolean(studentInfo.parent_connected),
    connectedParent: studentInfo.connected_parent ?? null,
    parentId: studentInfo.parent_id ?? null,
    counsellorId: studentInfo.counsellor_id ?? null,
    assignedCounsellor: studentInfo.assigned_counsellor ?? null,
    assignedCounsellorId: studentInfo.assigned_counsellor?.id ?? null,
  }));
}));

const OtpRequestSchema = z.object({
  phone: z.string().min(7),
  email: z.string().email().optional(),
  purpose: z.enum(['login', 'verify_student']),
});

authRoutes.post('/login/otp/request', validate(OtpRequestSchema), asyncHandler(async (req, res) => {
  res.json(success({
    otpToken: crypto.randomUUID(),
    expiresInSec: 300,
    sentTo: req.body.phone,
  }));
}));

const OtpVerifySchema = z.object({
  otpToken: z.string().min(1),
  otp: z.string().min(4).max(8),
});

authRoutes.post('/login/otp/verify', validate(OtpVerifySchema), asyncHandler(async (_req, _res) => {
  throw ApiError.badRequest('AUTH_UNAUTHENTICATED', 'OTP verification stub — implement SMS provider');
}));

const PasswordForgotSchema = z.object({ email: z.string().email() });
authRoutes.post('/password/forgot', validate(PasswordForgotSchema), asyncHandler(async (_req, res) => {
  res.json(success({ ok: true } as any));
}));

const PasswordResetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(6),
});
authRoutes.post('/password/reset', validate(PasswordResetSchema), asyncHandler(async (_req, res) => {
  res.json(success({ ok: true } as any));
}));
