-- AlterTable
ALTER TABLE "report_stories" ADD COLUMN     "image_url" TEXT;

-- CreateTable
CREATE TABLE "hourly_reports" (
    "id" TEXT NOT NULL,
    "report_hour" TIMESTAMP(3) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "source_subreddits" JSONB,
    "llm_model" TEXT,
    "llm_cost_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hourly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hourly_stories" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "subreddit" TEXT NOT NULL,
    "reddit_post_id" TEXT NOT NULL,
    "reddit_permalink" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "post_url" TEXT,
    "image_url" TEXT,
    "author" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "num_comments" INTEGER NOT NULL DEFAULT 0,
    "created_utc" TIMESTAMP(3),
    "summary" TEXT,
    "sentiment_label" TEXT,
    "topic_tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hourly_stories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hourly_reports_report_hour_key" ON "hourly_reports"("report_hour");

-- CreateIndex
CREATE INDEX "hourly_stories_report_id_rank_idx" ON "hourly_stories"("report_id", "rank");

-- CreateIndex
CREATE INDEX "hourly_stories_subreddit_idx" ON "hourly_stories"("subreddit");

-- CreateIndex
CREATE INDEX "hourly_stories_reddit_post_id_idx" ON "hourly_stories"("reddit_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "hourly_stories_report_id_rank_key" ON "hourly_stories"("report_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "hourly_stories_report_id_reddit_post_id_key" ON "hourly_stories"("report_id", "reddit_post_id");

-- AddForeignKey
ALTER TABLE "hourly_stories" ADD CONSTRAINT "hourly_stories_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "hourly_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
