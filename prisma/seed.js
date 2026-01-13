require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CATEGORIES = [
  {
    slug: 'tech',
    name: 'Tech & Programming',
    description: 'Software development, programming languages, and technology news',
    sortOrder: 1,
    subreddits: [
      'programming',
      'webdev',
      'javascript',
      'python',
      'machinelearning',
      'devops',
      'rust',
      'golang',
      'reactjs',
      'node',
    ],
  },
  {
    slug: 'science',
    name: 'Science & Future',
    description: 'Scientific discoveries, space exploration, and futurism',
    sortOrder: 2,
    subreddits: [
      'science',
      'space',
      'futurology',
      'technology',
      'artificial',
      'physics',
      'biology',
      'chemistry',
      'astronomy',
      'engineering',
    ],
  },
  {
    slug: 'finance',
    name: 'Finance & Business',
    description: 'Investing, personal finance, startups, and entrepreneurship',
    sortOrder: 3,
    subreddits: [
      'investing',
      'stocks',
      'personalfinance',
      'startups',
      'entrepreneur',
      'smallbusiness',
      'economics',
      'financialindependence',
      'business',
      'wallstreetbets',
    ],
  },
  {
    slug: 'gaming',
    name: 'Gaming',
    description: 'Video games, PC gaming, and gaming culture',
    sortOrder: 4,
    subreddits: [
      'games',
      'gaming',
      'pcgaming',
      'indiegaming',
      'gamedev',
      'truegaming',
      'patientgamers',
      'nintendo',
      'playstation',
      'xbox',
    ],
  },
  {
    slug: 'entertainment',
    name: 'Entertainment',
    description: 'Movies, TV shows, music, and pop culture',
    sortOrder: 5,
    subreddits: [
      'movies',
      'television',
      'music',
      'books',
      'netflix',
      'marvelstudios',
      'hiphopheads',
      'indieheads',
      'anime',
      'podcasts',
    ],
  },
  {
    slug: 'news',
    name: 'News & World',
    description: 'Current events, world news, and geopolitics',
    sortOrder: 6,
    subreddits: [
      'worldnews',
      'news',
      'geopolitics',
      'neutralnews',
      'UplsiftingNews',
      'inthenews',
      'qualitynews',
      'foreignpolicy',
      'globaltalk',
      'anime_titties',
    ],
  },
  {
    slug: 'selfimprovement',
    name: 'Self-Improvement',
    description: 'Productivity, fitness, health, and personal growth',
    sortOrder: 7,
    subreddits: [
      'productivity',
      'getdisciplined',
      'fitness',
      'nutrition',
      'loseit',
      'selfimprovement',
      'decidingtobebetter',
      'meditation',
      'sleep',
      'bodyweightfitness',
    ],
  },
  {
    slug: 'creative',
    name: 'Design & Creative',
    description: 'Design, photography, art, and creative work',
    sortOrder: 8,
    subreddits: [
      'design',
      'graphic_design',
      'photography',
      'Art',
      'web_design',
      'UI_Design',
      'AdobeIllustrator',
      'photoshop',
      'blender',
      'DigitalArt',
    ],
  },
  {
    slug: 'diy',
    name: 'DIY & Hobbies',
    description: 'Home improvement, crafts, and hands-on projects',
    sortOrder: 9,
    subreddits: [
      'DIY',
      'woodworking',
      'gardening',
      'homeimprovement',
      'electronics',
      '3Dprinting',
      'crafts',
      'sewing',
      'metalworking',
      'Leathercraft',
    ],
  },
];

async function seed() {
  console.log('Seeding categories and subreddits...');

  for (const cat of CATEGORIES) {
    const { subreddits, ...categoryData } = cat;

    // Upsert category
    const category = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {
        name: categoryData.name,
        description: categoryData.description,
        sortOrder: categoryData.sortOrder,
      },
      create: categoryData,
    });

    console.log(`  Created/updated category: ${category.name}`);

    // Upsert subreddits
    for (const [index, subName] of subreddits.entries()) {
      await prisma.subreddit.upsert({
        where: { name: subName },
        update: {
          categoryId: category.id,
          sortOrder: index,
        },
        create: {
          name: subName,
          categoryId: category.id,
          sortOrder: index,
          isDefault: true,
        },
      });
      console.log(`    - r/${subName}`);
    }
  }

  console.log('Seeding complete!');
}

seed()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
