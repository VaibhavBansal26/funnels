-- Page builder rebuilt on GrapesJS (ADR 0022). doc_json now holds version-2 documents ({version:2, project, forms, products}); version-1 block documents are
-- converted deterministically on startup (and lazily for backups). The original legacy document is kept here so a conversion can always be audited or redone.
ALTER TABLE step_pages ADD COLUMN legacy_doc_json TEXT;
