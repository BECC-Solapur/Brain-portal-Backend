-- Migration V012: Ensure assigned_counsellor_id and current_counsellor_id are present and synced on inquiries

ALTER TABLE inquiries 
  ADD COLUMN IF NOT EXISTS assigned_counsellor_id UUID REFERENCES counsellors(id) ON DELETE SET NULL;

ALTER TABLE appointments 
  ADD COLUMN IF NOT EXISTS slot_time_display VARCHAR(50);

-- Sync any existing values
UPDATE inquiries 
SET assigned_counsellor_id = current_counsellor_id 
WHERE assigned_counsellor_id IS NULL AND current_counsellor_id IS NOT NULL;

UPDATE inquiries 
SET current_counsellor_id = assigned_counsellor_id 
WHERE current_counsellor_id IS NULL AND assigned_counsellor_id IS NOT NULL;

-- Trigger to keep assigned_counsellor_id and current_counsellor_id always synchronized
CREATE OR REPLACE FUNCTION sync_inquiry_counsellor_ids()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_counsellor_id IS NOT NULL AND (NEW.assigned_counsellor_id IS NULL OR NEW.current_counsellor_id <> COALESCE(OLD.current_counsellor_id, '00000000-0000-0000-0000-000000000000'::uuid)) THEN
    NEW.assigned_counsellor_id := NEW.current_counsellor_id;
  ELSIF NEW.assigned_counsellor_id IS NOT NULL AND (NEW.current_counsellor_id IS NULL OR NEW.assigned_counsellor_id <> COALESCE(OLD.assigned_counsellor_id, '00000000-0000-0000-0000-000000000000'::uuid)) THEN
    NEW.current_counsellor_id := NEW.assigned_counsellor_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_inquiry_counsellor ON inquiries;
CREATE TRIGGER trg_sync_inquiry_counsellor
BEFORE INSERT OR UPDATE ON inquiries
FOR EACH ROW
EXECUTE FUNCTION sync_inquiry_counsellor_ids();

-- Map existing unmapped inquiries to the active primary counsellor (Arpita Kulkarni)
DO $$
DECLARE
  v_counsellor_id UUID;
  v_inq RECORD;
  v_slot_idx INT := 0;
  v_start_times TIME[] := ARRAY['09:00:00'::time, '11:00:00'::time, '14:00:00'::time, '16:00:00'::time, '17:00:00'::time];
  v_end_times TIME[] := ARRAY['10:00:00'::time, '12:00:00'::time, '15:00:00'::time, '17:00:00'::time, '18:00:00'::time];
  v_displays TEXT[] := ARRAY['09:00 AM – 10:00 AM', '11:00 AM – 12:00 PM', '02:00 PM – 03:00 PM', '04:00 PM – 05:00 PM', '05:00 PM – 06:00 PM'];
  v_len INT := 5;
BEGIN
  SELECT id INTO v_counsellor_id FROM counsellors WHERE user_id IS NOT NULL AND deleted_at IS NULL AND is_active = TRUE ORDER BY created_at ASC LIMIT 1;
  IF v_counsellor_id IS NOT NULL THEN
    UPDATE inquiries 
    SET current_counsellor_id = v_counsellor_id,
        assigned_counsellor_id = v_counsellor_id
    WHERE current_counsellor_id IS NULL;

    -- Ensure an appointment row exists for these inquiries
    FOR v_inq IN 
      SELECT i.id, i.organization_id, i.branch_id, i.student_id, i.form_date
      FROM inquiries i
      WHERE NOT EXISTS (SELECT 1 FROM appointments a WHERE a.inquiry_id = i.id)
    LOOP
      v_slot_idx := (v_slot_idx % v_len) + 1;
      INSERT INTO appointments (
        organization_id, inquiry_id, branch_id, counsellor_id,
        appointment_date, slot_start_time, slot_end_time, slot_time_display,
        mode, status, is_primary, location, created_at, updated_at
      ) VALUES (
        v_inq.organization_id, v_inq.id, v_inq.branch_id, v_counsellor_id,
        CURRENT_DATE + ((v_slot_idx - 1) / v_len), 
        v_start_times[v_slot_idx], v_end_times[v_slot_idx], v_displays[v_slot_idx],
        'in_person', 'booked', TRUE, 'BRAIN Counselling Center · Pune Campus', NOW(), NOW()
      );
    END LOOP;
  END IF;
END $$;
