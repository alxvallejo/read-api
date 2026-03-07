-- CreateTable
CREATE TABLE "saved_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "favicon" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_links_user_id_created_at_idx" ON "saved_links"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "saved_links_user_id_url_key" ON "saved_links"("user_id", "url");

-- AddForeignKey
ALTER TABLE "saved_links" ADD CONSTRAINT "saved_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
