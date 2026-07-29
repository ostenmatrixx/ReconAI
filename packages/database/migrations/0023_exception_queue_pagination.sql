CREATE INDEX "exceptions_org_severity_age_id_idx"
ON "exceptions" (
  "organization_id",
  (CASE "severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END),
  "created_at",
  "id"
);

CREATE INDEX "exceptions_org_type_idx"
ON "exceptions" ("organization_id", "type");
