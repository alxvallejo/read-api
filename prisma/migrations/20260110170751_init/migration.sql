-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SampleBucket" AS ENUM ('TOP', 'CONTROVERSIAL', 'NEW');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('PENDING', 'ACTIVE', 'UNSUBSCRIBED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('REACT_INTERESTING', 'SAVE', 'FOLLOW_TOPIC', 'SUBSCRIBE_CLICK', 'STORY_CLICK');

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" TEXT NOT NULL,
    "report_date" DATE NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "summary" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "source_timezone" TEXT NOT NULL,
    "llm_model" TEXT,
    "llm_cost_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_stories" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "subreddit" TEXT NOT NULL,
    "reddit_post_id" TEXT NOT NULL,
    "reddit_permalink" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "post_url" TEXT,
    "author" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "num_comments" INTEGER NOT NULL DEFAULT 0,
    "created_utc" TIMESTAMP(3),
    "selection_score" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "summary" TEXT,
    "sentiment_label" TEXT,
    "takeaways" JSONB,
    "topic_tags" JSONB,
    "content_warning" TEXT,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_comments" (
    "id" TEXT NOT NULL,
    "story_id" TEXT NOT NULL,
    "reddit_comment_id" TEXT NOT NULL,
    "reddit_permalink" TEXT NOT NULL,
    "author" TEXT,
    "body" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "created_utc" TIMESTAMP(3),
    "sample_bucket" "SampleBucket" NOT NULL,
    "position_in_bucket" INTEGER NOT NULL,
    "is_highlighted" BOOLEAN NOT NULL DEFAULT false,
    "highlight_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "SubStatus" NOT NULL DEFAULT 'PENDING',
    "topics" JSONB,
    "source" TEXT NOT NULL,
    "referrer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_events" (
    "id" TEXT NOT NULL,
    "anonymous_id" TEXT NOT NULL,
    "event_type" "EventType" NOT NULL,
    "report_id" TEXT,
    "story_id" TEXT,
    "metadata" JSONB,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engagement_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_report_date_key" ON "daily_reports"("report_date");

-- CreateIndex
CREATE INDEX "report_stories_report_id_rank_idx" ON "report_stories"("report_id", "rank");

-- CreateIndex
CREATE INDEX "report_stories_subreddit_idx" ON "report_stories"("subreddit");

-- CreateIndex
CREATE INDEX "report_stories_reddit_post_id_idx" ON "report_stories"("reddit_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_stories_report_id_rank_key" ON "report_stories"("report_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "report_stories_subreddit_reddit_post_id_key" ON "report_stories"("subreddit", "reddit_post_id");

-- CreateIndex
CREATE INDEX "story_comments_story_id_idx" ON "story_comments"("story_id");

-- CreateIndex
CREATE INDEX "story_comments_is_highlighted_idx" ON "story_comments"("is_highlighted");

-- CreateIndex
CREATE UNIQUE INDEX "story_comments_story_id_reddit_comment_id_key" ON "story_comments"("story_id", "reddit_comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_email_key" ON "subscriptions"("email");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_created_at_idx" ON "subscriptions"("created_at" DESC);

-- CreateIndex
CREATE INDEX "engagement_events_created_at_idx" ON "engagement_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "engagement_events_event_type_created_at_idx" ON "engagement_events"("event_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "engagement_events_report_id_idx" ON "engagement_events"("report_id");

-- CreateIndex
CREATE INDEX "engagement_events_story_id_idx" ON "engagement_events"("story_id");

-- CreateIndex
CREATE INDEX "engagement_events_anonymous_id_created_at_idx" ON "engagement_events"("anonymous_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "report_stories" ADD CONSTRAINT "report_stories_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "daily_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_comments" ADD CONSTRAINT "story_comments_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "report_stories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "report_stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
