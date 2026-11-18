-- OCR of incoming-letter attachments and an AI-suggested summary («شرح نامه»).
-- The text read from a scan is stored with the attachment (the database is the place letter text already lives) and
-- indexed by the smart search. Only unclassified letters are ever summarised by the AI provider.

ALTER TABLE letter_attachments
  ADD COLUMN ocr_status text CHECK (ocr_status IN ('pending','done','empty','failed','unsupported')),
  ADD COLUMN ocr_text   text,
  ADD COLUMN ocr_method text,          -- text-layer (PDF with text) | ocr (Tesseract)
  ADD COLUMN ocr_pages  int,
  ADD COLUMN ocr_error  text,
  ADD COLUMN ocr_at     timestamptz;

ALTER TABLE letters
  ADD COLUMN ai_summary    text,        -- last summary suggested by the AI provider (shown for review)
  ADD COLUMN ai_summary_at timestamptz;
