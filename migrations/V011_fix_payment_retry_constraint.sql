-- V011: Fix unique constraint on payments to allow retry for failed/pending payments
-- Drop the rigid unique constraint that blocks retrying installments
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_inquiry_id_direction_installment_number_key;

-- Ensure an installment can only ever be successfully PAID once per inquiry and direction
CREATE UNIQUE INDEX IF NOT EXISTS payments_inquiry_paid_installment_key
  ON payments (inquiry_id, direction, installment_number)
  WHERE status = 'paid';

-- Composite index for fast inquiry payment lookups
CREATE INDEX IF NOT EXISTS idx_payments_inquiry_direction_installment
  ON payments (inquiry_id, direction, installment_number);
