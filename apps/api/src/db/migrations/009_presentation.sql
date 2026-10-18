-- Live presentation of a meeting document (ارائه مستقیم): the page every participant follows.
ALTER TABLE meetings ADD COLUMN presentation jsonb;
-- PDF made from a PowerPoint/Word document for presenting (cached next to the original).
ALTER TABLE documents ADD COLUMN pdf_key text;
-- Number of pages of the presented PDF (rendered page by page to images for viewers).
ALTER TABLE documents ADD COLUMN page_count int;
