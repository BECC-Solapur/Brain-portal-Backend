/*
===============================================================================
MIGRATION V002 — Referral / Coupon Management Module
Schema Version: 1.1.0
Authoritative schema addition on top of V001.

Business Context:
  BRAIN Educational Center engages Teachers, Counsellors, Sales Persons, and
  Channel Partners as referral sources. Each referrer is assigned a unique,
  human-readable referral code. When a student applies for a counselling
  program and enters a valid referral code during inquiry intake, the system
  applies the configured discount to the program fee and attributes the
  conversion to the referrer for reporting.

Referral Code → One-to-Many → Inquiries (one code used by many inquiries)
Inquiry → Zero-to-One → Referral Code (student may optionally enter a code)
Payment → Immutable Discount Snapshot (never changes even if referral code is
           edited later — preserves historical financial accuracy)

===============================================================================
*/

-- =========================================================================
-- 1. ENUM TYPES (new for referral module — idempotent DO blocks)
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'referral_type_enum') THEN
        CREATE TYPE referral_type_enum AS ENUM (
            'teacher',
            'counsellor',
            'sales_person',
            'channel_partner',
            'student_ambassador',
            'alumni',
            'corporate_partner',
            'marketing_campaign',
            'other'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discount_type_enum') THEN
        CREATE TYPE discount_type_enum AS ENUM (
            'percentage',
            'fixed_amount'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'referral_status_enum') THEN
        CREATE TYPE referral_status_enum AS ENUM (
            'active',
            'paused',
            'expired',
            'used_up',
            'revoked'
        );
    END IF;
END $$;

-- =========================================================================
-- 2. REFERRAL CODES TABLE (master record per code)
-- =========================================================================

CREATE TABLE IF NOT EXISTS referral_codes (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id                   UUID REFERENCES branches(id) ON DELETE SET NULL,

    code                        VARCHAR(50) NOT NULL,
    display_name                VARCHAR(200),
    description                 TEXT,

    referral_type               referral_type_enum NOT NULL DEFAULT 'other',

    referrer_full_name          VARCHAR(300),
    referrer_email              CITEXT,
    referrer_phone              VARCHAR(20),
    referrer_user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    referrer_counsellor_id      UUID REFERENCES counsellors(id) ON DELETE SET NULL,

    external_partner_company    VARCHAR(300),
    external_partner_contact    VARCHAR(300),
    partner_payout_agreement    TEXT,

    discount_type               discount_type_enum NOT NULL DEFAULT 'percentage',
    discount_value              NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),

    max_discount_amount_cap     NUMERIC(12,2),
    min_invoice_amount_eligible NUMERIC(12,2),

    valid_from                  DATE,
    valid_until                 DATE,

    max_total_usage_limit       INTEGER CHECK (max_total_usage_limit IS NULL OR max_total_usage_limit >= 0),
    max_usage_per_student       INTEGER DEFAULT 1 CHECK (max_usage_per_student IS NULL OR max_usage_per_student >= 1),

    current_usage_count         INTEGER NOT NULL DEFAULT 0 CHECK (current_usage_count >= 0),
    unique_students_used_count  INTEGER NOT NULL DEFAULT 0 CHECK (unique_students_used_count >= 0),
    paid_conversions_count      INTEGER NOT NULL DEFAULT 0 CHECK (paid_conversions_count >= 0),

    total_discount_given_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_discount_given_amount >= 0),
    total_revenue_generated_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_revenue_generated_amount >= 0),

    is_program_restricted       BOOLEAN NOT NULL DEFAULT FALSE,
    is_new_students_only        BOOLEAN NOT NULL DEFAULT FALSE,

    status                      referral_status_enum NOT NULL DEFAULT 'active',
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at                  TIMESTAMPTZ,

    created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_referral_branch_composite
        FOREIGN KEY (branch_id, organization_id)
        REFERENCES branches(id, organization_id) ON DELETE SET NULL,

    CONSTRAINT chk_discount_percentage_range CHECK (
        discount_type != 'percentage'
        OR (discount_value >= 0 AND discount_value <= 100)
    ),
    CONSTRAINT chk_validity_period CHECK (
        valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from
    ),
    CONSTRAINT chk_code_format CHECK (
        char_length(trim(code)) >= 3
        AND code ~ '^[A-Za-z0-9\-_]+$'
    ),
    CONSTRAINT chk_cap_positive CHECK (
        max_discount_amount_cap IS NULL OR max_discount_amount_cap >= 0
    ),
    CONSTRAINT chk_min_invoice_positive CHECK (
        min_invoice_amount_eligible IS NULL OR min_invoice_amount_eligible >= 0
    ),
    CONSTRAINT chk_usage_counters_consistent CHECK (
        paid_conversions_count <= current_usage_count
        AND unique_students_used_count <= current_usage_count
    ),

    UNIQUE NULLS NOT DISTINCT (organization_id, code)
);

-- Composite UNIQUE index required for tenant integrity FK references
CREATE UNIQUE INDEX IF NOT EXISTS ux_referral_codes_id_org
    ON referral_codes(id, organization_id);

-- =========================================================================
-- 3. REFERRAL ↔ PROGRAM RESTRICTIONS JUNCTION
--    (Only used when is_program_restricted = TRUE)
-- =========================================================================

CREATE TABLE IF NOT EXISTS referral_program_restrictions (
    referral_code_id  UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    program_id        UUID NOT NULL,
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (referral_code_id, program_id),

    CONSTRAINT fk_refprog_program_composite
        FOREIGN KEY (program_id, organization_id)
        REFERENCES programs(id, organization_id) ON DELETE RESTRICT
);

-- =========================================================================
-- 4. ADD REFERRAL REFERENCE TO INQUIRIES (student's code selection)
--    Stored on the inquiry (not student) because each program purchase
--    may use a different referral code per the product spec.
-- =========================================================================

ALTER TABLE inquiries
    ADD COLUMN IF NOT EXISTS referral_code_id UUID
        REFERENCES referral_codes(id) ON DELETE SET NULL;

COMMENT ON COLUMN inquiries.referral_code_id
    IS 'Referral / coupon code entered by the student during this inquiry intake. NULL means no code was used. FK intentionally simple (not composite org) so reporting joins are ergonomic; tenant isolation enforced via RLS + application logic.';

ALTER TABLE inquiries
    ADD COLUMN IF NOT EXISTS referral_code_text_entered VARCHAR(50);

COMMENT ON COLUMN inquiries.referral_code_text_entered
    IS 'Raw text the student typed in the "Referral Code" field before lookup. Preserved even if the code was invalid, for audit and UX debugging.';

-- =========================================================================
-- 5. DISCOUNT SNAPSHOT FIELDS ON PAYMENTS TABLE (immutable once created)
--    These store a point-in-time copy so future edits to the referral code
--    (e.g., referrer changes, discount percentage adjustment, code deletion)
--    NEVER retroactively alter financial history — audit trail SSOT.
-- =========================================================================

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS referral_code_id UUID
        REFERENCES referral_codes(id) ON DELETE SET NULL;

COMMENT ON COLUMN payments.referral_code_id
    IS 'Referral code applied to this specific payment / installment. Points to master record for reporting joins, but all financial values are snapshotted below.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS referral_code_text_snapshot VARCHAR(50);

COMMENT ON COLUMN payments.referral_code_text_snapshot
    IS 'Immutable copy of referral_codes.code at payment creation time.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS discount_type_snapshot discount_type_enum;

COMMENT ON COLUMN payments.discount_type_snapshot
    IS 'Immutable copy of referral_codes.discount_type at payment creation.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS discount_value_snapshot NUMERIC(10,2)
        CHECK (discount_value_snapshot IS NULL OR discount_value_snapshot >= 0);

COMMENT ON COLUMN payments.discount_value_snapshot
    IS 'Immutable copy of referral_codes.discount_value at payment creation. Percentage (0-100) or rupees.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS subtotal_before_discount NUMERIC(12,2)
        DEFAULT 0 CHECK (subtotal_before_discount IS NULL OR subtotal_before_discount >= 0);

COMMENT ON COLUMN payments.subtotal_before_discount
    IS 'Program fee + service fee + GST BEFORE referral discount is subtracted. Total of what the student would have paid without a code.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS discount_amount_applied NUMERIC(12,2)
        DEFAULT 0 CHECK (discount_amount_applied IS NULL OR discount_amount_applied >= 0);

COMMENT ON COLUMN payments.discount_amount_applied
    IS 'Actual rupees discounted on this payment = min(max_cap, percentage_or_fixed). Stored, NOT recalculated.';

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS total_after_discount NUMERIC(12,2)
        DEFAULT 0 CHECK (total_after_discount IS NULL OR total_after_discount >= 0);

COMMENT ON COLUMN payments.total_after_discount
    IS 'Final invoiced amount = subtotal_before_discount - discount_amount_applied + round_off_adjustment_amount. Must equal existing payments.total_amount.';

-- Cross-check: existing total_amount must match new total_after_discount when
-- a discount is actually present. If no referral, total_after_discount == subtotal.
ALTER TABLE payments
    ADD CONSTRAINT IF NOT EXISTS chk_discount_arithmetic CHECK (
        (discount_amount_applied IS NULL OR discount_amount_applied = 0 OR subtotal_before_discount IS NOT NULL)
        AND (
            total_after_discount IS NULL
            OR ABS(
                total_after_discount
                - (COALESCE(subtotal_before_discount, 0)
                   - COALESCE(discount_amount_applied, 0)
                   + round_off_adjustment_amount)
            ) < 0.01
        )
        AND (
            discount_amount_applied IS NULL OR discount_amount_applied = 0
            OR ABS(total_after_discount - total_amount) < 0.01
        )
    );

-- =========================================================================
-- 6. ROW LEVEL SECURITY
-- =========================================================================

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_program_restrictions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    v_t TEXT;
    v_tables TEXT[] := ARRAY['referral_codes','referral_program_restrictions'];
BEGIN
    FOREACH v_t IN ARRAY v_tables LOOP
        BEGIN
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I', v_t);
        EXCEPTION WHEN OTHERS THEN NULL; END;
        EXECUTE format(
            'CREATE POLICY tenant_isolation_policy ON %I
             USING (
                 current_setting(''app.tenant_org_id'', true) IS NULL
                 OR current_user = ''postgres''
                 OR pg_has_role(current_user, ''pg_read_all_settings'', ''usage'')
                 OR organization_id::text = current_setting(''app.tenant_org_id'', true)
             )',
            v_t
        );
    END LOOP;
END $$;

-- =========================================================================
-- 7. INDEXES (FK, tenant, report & lookup patterns)
-- =========================================================================

-- Lookup by code (case-insensitive unique already handled by UNIQUE constraint;
-- add GIN for partial / prefix matching in UI search)
CREATE UNIQUE INDEX IF NOT EXISTS ux_referral_codes_code_ci_org
    ON referral_codes(organization_id, lower(code));

CREATE INDEX IF NOT EXISTS idx_referral_codes_org_status
    ON referral_codes(organization_id, status, is_active)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_type
    ON referral_codes(organization_id, referral_type)
    WHERE is_active = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_referrer_user
    ON referral_codes(referrer_user_id)
    WHERE referrer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_referrer_counsellor
    ON referral_codes(referrer_counsellor_id)
    WHERE referrer_counsellor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referral_codes_validity_window
    ON referral_codes(organization_id, valid_from, valid_until)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_referral_codes_conversions_desc
    ON referral_codes(organization_id, paid_conversions_count DESC, total_revenue_generated_amount DESC)
    WHERE is_active = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referral_prog_restr_program
    ON referral_program_restrictions(program_id);

-- Inquiries → referral join (admin dashboard "students who used code X")
CREATE INDEX IF NOT EXISTS idx_inquiries_referral_code
    ON inquiries(referral_code_id)
    WHERE referral_code_id IS NOT NULL;

-- Payments → referral join (financial reconciliation "discount by code")
CREATE INDEX IF NOT EXISTS idx_payments_referral_code
    ON payments(referral_code_id)
    WHERE referral_code_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_referral_snapshot
    ON payments(referral_code_text_snapshot)
    WHERE referral_code_text_snapshot IS NOT NULL;

-- =========================================================================
-- 8. set_updated_at TRIGGERS
-- =========================================================================

DROP TRIGGER IF EXISTS trg_referral_codes_updated ON referral_codes;
CREATE TRIGGER trg_referral_codes_updated
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- 9. ANALYTICAL VIEW: Referrer Leaderboard (for Admin & Partner Portal)
-- =========================================================================

CREATE OR REPLACE VIEW v_referral_leaderboard AS
SELECT
    rc.id                            AS referral_code_id,
    rc.code                          AS referral_code,
    rc.display_name                  AS campaign_name,
    rc.referral_type                 AS referrer_type,
    rc.referrer_full_name            AS referrer_name,
    rc.referrer_email,
    rc.referrer_phone,
    b.code                           AS branch_code,
    b.name                           AS branch_name,
    rc.discount_type,
    rc.discount_value,
    rc.status,
    rc.created_at                    AS code_created_at,
    rc.current_usage_count           AS total_applications,
    rc.unique_students_used_count    AS unique_students,
    rc.paid_conversions_count        AS paid_students,
    rc.total_discount_given_amount   AS total_discount_given,
    rc.total_revenue_generated_amount AS total_revenue_attributed,
    CASE
        WHEN rc.total_discount_given_amount > 0
        THEN ROUND(
            (rc.total_revenue_generated_amount / rc.total_discount_given_amount)::numeric, 2
        )
        ELSE NULL
    END                              AS roi_ratio,
    CASE
        WHEN rc.current_usage_count > 0
        THEN ROUND(
            (rc.paid_conversions_count::numeric / rc.current_usage_count::numeric) * 100, 2
        )
        ELSE 0
    END                              AS conversion_pct,
    rc.valid_from,
    rc.valid_until,
    rc.max_total_usage_limit,
    CASE
        WHEN rc.max_total_usage_limit IS NULL THEN NULL
        ELSE ROUND(
            (rc.current_usage_count::numeric / rc.max_total_usage_limit::numeric) * 100, 2
        )
    END                              AS utilization_pct
FROM referral_codes rc
LEFT JOIN branches b ON b.id = rc.branch_id AND b.organization_id = rc.organization_id
WHERE rc.deleted_at IS NULL
ORDER BY rc.total_revenue_generated_amount DESC, rc.paid_conversions_count DESC;

COMMENT ON VIEW v_referral_leaderboard
    IS 'Admin / partner-portal referral leaderboard: performance, ROI, conversion %, utilization & validity per code.';

-- =========================================================================
-- END OF MIGRATION V002
-- =========================================================================
