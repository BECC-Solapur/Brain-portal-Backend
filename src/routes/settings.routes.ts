import { Router } from 'express';
export const settingsRoutes = Router();
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler, success, ApiError } from '../types/api';
import { query } from '../config/db';

// GET /api/v1/settings/organization - Fetch organization & branch configuration
settingsRoutes.get('/organization', requireAuth(), asyncHandler(async (req, res) => {
  const auth = req.auth!;

  const { rows: [org] } = await query<any>(`
    SELECT * FROM organizations WHERE id = $1
  `, [auth.orgId]);

  if (!org) throw ApiError.notFound('Organization profile not found');

  const { rows: branches } = await query<any>(`
    SELECT id, code, name, address_line1, address_line2, city, state, pincode, phone_primary, phone_secondary, email, incharge_name, is_active
    FROM branches
    WHERE organization_id = $1
    ORDER BY name
  `, [auth.orgId]);

  res.json(success({
    id: org.id,
    name: org.name,
    legalName: org.legal_name,
    tagline: org.tagline,
    registrationNumber: org.registration_number,
    gstin: org.gstin,
    pan: org.pan,
    logoUrl: org.logo_storage_key,
    primaryEmail: org.email,
    email: org.email,
    primaryPhone: org.phone_primary,
    phonePrimary: org.phone_primary,
    phoneSecondary: org.phone_secondary,
    websiteUrl: org.website,
    website: org.website,
    supportEmail: org.support_email,
    currencyCode: 'INR',
    timezone: 'Asia/Kolkata',
    branches: branches.map(b => ({
      id: b.id,
      code: b.code,
      name: b.name,
      addressLine1: b.address_line1,
      addressLine2: b.address_line2,
      city: b.city,
      state: b.state,
      postalCode: b.pincode,
      pincode: b.pincode,
      phoneNumber: b.phone_primary,
      phonePrimary: b.phone_primary,
      phoneSecondary: b.phone_secondary,
      email: b.email,
      inchargeName: b.incharge_name,
      isActive: b.is_active,
    })),
    systemFeatures: {
      enableSmsNotifications: true,
      enableEmailVouchers: true,
      enableGstInvoicing: true,
      defaultGstRate: 18.0,
      enableRazorpayGateway: true,
      strictPaymentGuardForBooking: true,
    },
  }));
}));

const UpdateOrgSchema = z.object({
  name: z.string().min(2).optional(),
  primaryEmail: z.string().email().optional(),
  email: z.string().email().optional(),
  primaryPhone: z.string().optional(),
  phonePrimary: z.string().optional(),
  websiteUrl: z.string().url().optional(),
  website: z.string().url().optional(),
  tagline: z.string().optional(),
});

// PATCH /api/v1/settings/organization - Update organization profile
settingsRoutes.patch('/organization', requireAuth(), validate(UpdateOrgSchema), asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const d = req.body;

  const targetEmail = d.primaryEmail || d.email || null;
  const targetPhone = d.primaryPhone || d.phonePrimary || null;
  const targetWebsite = d.websiteUrl || d.website || null;

  const { rows: [updated] } = await query<any>(`
    UPDATE organizations
    SET name = COALESCE($1, name),
        email = COALESCE($2, email),
        phone_primary = COALESCE($3, phone_primary),
        website = COALESCE($4, website),
        tagline = COALESCE($5, tagline),
        updated_at = NOW()
    WHERE id = $6
    RETURNING *
  `, [
    d.name || null,
    targetEmail,
    targetPhone,
    targetWebsite,
    d.tagline || null,
    auth.orgId,
  ]);

  if (!updated) throw ApiError.notFound('Organization profile not found');

  res.json(success({
    id: updated.id,
    name: updated.name,
    legalName: updated.legal_name,
    tagline: updated.tagline,
    primaryEmail: updated.email,
    email: updated.email,
    primaryPhone: updated.phone_primary,
    phonePrimary: updated.phone_primary,
    websiteUrl: updated.website,
    website: updated.website,
  }));
}));
