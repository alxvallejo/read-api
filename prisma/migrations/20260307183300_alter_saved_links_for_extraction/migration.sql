-- AlterTable: make title nullable, add extraction columns, drop unused columns
ALTER TABLE "saved_links" ALTER COLUMN "title" DROP NOT NULL;
ALTER TABLE "saved_links" ADD COLUMN "image_url" TEXT;
ALTER TABLE "saved_links" ADD COLUMN "domain" TEXT;
ALTER TABLE "saved_links" ADD COLUMN "extracted_content" TEXT;
ALTER TABLE "saved_links" DROP COLUMN IF EXISTS "description";
ALTER TABLE "saved_links" DROP COLUMN IF EXISTS "favicon";
ALTER TABLE "saved_links" DROP COLUMN IF EXISTS "tags";
ALTER TABLE "saved_links" DROP COLUMN IF EXISTS "note";
