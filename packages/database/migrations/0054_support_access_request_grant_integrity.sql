-- Bind every claimed support request to the exact tenant-scoped grant created when it was claimed.
-- The request state check already requires both columns together; this composite foreign key closes
-- the remaining relational integrity boundary without granting either runtime role table access.

ALTER TABLE public.support_access_requests
  ADD CONSTRAINT support_access_requests_claimed_grant_fk
  FOREIGN KEY (claimed_organization_id, claimed_grant_id)
  REFERENCES public.support_access_grants (organization_id, id);
