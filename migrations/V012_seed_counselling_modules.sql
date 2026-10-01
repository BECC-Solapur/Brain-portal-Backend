-- Ensure every organization has the counselling modules offered by the UI.
INSERT INTO programs (
  organization_id, code, name, tagline, grade_range, description,
  price, gst_rate_percent, service_fee_rate_percent, icon_name, sort_order, is_active
)
SELECT organization.id, module.code, module.name, module.tagline, module.grade_range,
       module.description, module.price, 18.00, 0.00, module.icon_name, module.sort_order, TRUE
FROM organizations organization
CROSS JOIN (VALUES
  ('ankur',   'Ankur',   'Foundation Years',      'KG to 4th',       'Foundational learning and early development counselling.', 1499.00, 'Sprout', 1),
  ('palavi',  'Palavi',  'Growing Minds',         '5th to 7th',      'Study habits, interests, and transition-year counselling.', 1999.00, 'Leaf',   2),
  ('lakshya', 'Lakshya', 'Target Excellence',     '8th to 10th',     'Board preparation, stream selection, and career foundation.', 2499.00, 'Target', 3),
  ('disha',   'Disha',   'Choose Your Direction', '11th to 12th',    'College, entrance examination, admission, and scholarship guidance.', 2999.00, 'Target', 4),
  ('udaan',   'Udaan',   'Soar Higher',           'Graduates',       'Higher studies, competitive examinations, and placement guidance.', 2999.00, 'Plane',  5),
  ('phoenix', 'Phoenix', 'Rise & Transform',      'Professionals',   'Career transition, skill-gap, and professional growth counselling.', 3999.00, 'Flame',  6)
) AS module(code, name, tagline, grade_range, description, price, icon_name, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM programs existing
  WHERE existing.organization_id=organization.id AND LOWER(existing.code)=LOWER(module.code)
);

-- Repair legacy paid registrations where the selected module was represented
-- only by its fee. Disha and Udaan intentionally are not inferred because they
-- share a price; new registrations persist their exact selected module.
UPDATE inquiries inquiry
SET program_id = matched_program.id,
    updated_at = NOW()
FROM programs matched_program
WHERE inquiry.program_id IS NULL
  AND matched_program.organization_id=inquiry.organization_id
  AND matched_program.is_active=TRUE
  AND matched_program.price=(
    SELECT payment.program_fee_amount
    FROM payments payment
    WHERE payment.inquiry_id=inquiry.id AND payment.status='paid'
    ORDER BY payment.paid_at DESC NULLS LAST, payment.created_at DESC
    LIMIT 1
  )
  AND matched_program.price IN (1499.00, 1999.00, 2499.00, 3999.00);
