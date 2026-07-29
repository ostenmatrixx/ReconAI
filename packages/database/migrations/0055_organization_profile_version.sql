-- Add explicit optimistic concurrency authority for organization profile changes.
-- The constant default makes existing rows version 1 without application backfill.

ALTER TABLE public.organizations
  ADD COLUMN profile_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_profile_version_check
  CHECK (profile_version > 0)
  NOT VALID;

ALTER TABLE public.organizations
  VALIDATE CONSTRAINT organizations_profile_version_check;
