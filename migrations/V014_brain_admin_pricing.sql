-- Store AI CMT alongside organization-scoped sellable products so pricing,
-- checkout, receipts, and the Brain Admin editor share one source of truth.
INSERT INTO programs (
  organization_id, code, name, tagline, grade_range, description,
  price, gst_rate_percent, service_fee_rate_percent, icon_name, sort_order, is_active
)
SELECT organization.id, 'cmt', 'AI CMT', 'Psychometric Assessment', 'All students',
       'AI-assisted competency mapping and psychometric assessment.',
       1271.00, 18.00, 0.00, 'Brain', 99, TRUE
FROM organizations organization
WHERE NOT EXISTS (
  SELECT 1 FROM programs existing
  WHERE existing.organization_id=organization.id AND LOWER(existing.code)='cmt'
);
