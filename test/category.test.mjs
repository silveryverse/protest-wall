import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import {
  categoryForPost,
  filterPosts,
  inferCategory,
  routeForView,
  sortPosts,
  viewFromHash,
} from '../public/feed-model.js';

const PASSWORD = 'correct horse battery';

async function setup(initialPosts = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'protest-wall-category-'));
  if (initialPosts.length) await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify({ posts: initialPosts, config: { summary: '', demands: [], sourceUrl: '', confirmed: false } }));
  const server = createApp({ dataDir, adminPassword: PASSWORD, loginLimit: 20, submissionLimit: 30 });
  await server.ready;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  return { response, body: await response.json() };
}

function json(method, body, headers = {}) {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

test('category inference, filtering, searching and sorting are deterministic', () => {
  const posts = [
    { id: 'poster', type: 'poster', title: 'Ink', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'meme', type: 'image', satire: true, title: 'A joke', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'news', type: 'text', url: 'https://example.com/story', title: 'Election source', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'protest', type: 'text', title: 'A demand', createdAt: '2026-01-04T00:00:00Z' },
  ];
  assert.equal(inferCategory(posts[0]), 'posters');
  assert.equal(inferCategory(posts[1]), 'memes');
  assert.equal(categoryForPost({ category: 'news', type: 'text' }), 'news');
  assert.deepEqual(filterPosts(posts, { filter: 'memes' }).map((post) => post.id), ['meme']);
  assert.deepEqual(filterPosts(posts, { search: 'election' }).map((post) => post.id), ['news']);
  assert.deepEqual(sortPosts(posts, 'oldest').map((post) => post.id), ['poster', 'news', 'meme', 'protest']);
});

test('legacy stored posts receive backward-compatible categories', async (t) => {
  const app = await setup([
    { id: 'legacy-poster', type: 'poster', title: 'Poster', status: 'approved', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'legacy-meme', type: 'image', satire: true, title: 'Meme', status: 'approved', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'legacy-news', type: 'text', url: 'https://example.com/story', title: 'News', status: 'approved', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'legacy-protest', type: 'text', title: 'Protest', status: 'approved', createdAt: '2026-01-04T00:00:00Z' },
  ]);
  t.after(app.close);
  const posts = (await request(app.base, '/api/posts')).body.posts;
  assert.deepEqual(posts.map((post) => post.category), ['protests', 'news', 'memes', 'posters']);
});

test('hash navigation maps direct links and unknown hashes to home', () => {
  assert.equal(viewFromHash('#protests'), 'protests');
  assert.equal(viewFromHash('#memes'), 'memes');
  assert.equal(viewFromHash('#posters'), 'posters');
  assert.equal(viewFromHash('#manifesto'), 'home');
  assert.equal(viewFromHash('#nope'), 'home');
  assert.equal(routeForView('protests'), '#protests');
  assert.equal(routeForView('nope'), '#home');
});

test('API persists allowed categories, infers auto, rejects invalid category media, and preserves moderation', async (t) => {
  const app = await setup();
  t.after(app.close);
  const submissions = [
    { type: 'poster', category: 'auto', title: 'Poster', url: 'https://example.com/poster.png' },
    { type: 'image', category: 'memes', title: 'Meme', url: 'https://example.com/meme.png', satire: true },
    { type: 'text', category: 'news', title: 'News', url: 'https://example.com/article' },
  ];
  for (const submission of submissions) assert.equal((await request(app.base, '/api/posts', json('POST', submission))).response.status, 201);
  const invalidCategory = await request(app.base, '/api/posts', json('POST', { type: 'text', category: 'bogus', title: 'Bad', text: 'Nope' }));
  assert.equal(invalidCategory.response.status, 400);
  const invalidPoster = await request(app.base, '/api/posts', json('POST', { type: 'text', category: 'posters', title: 'Bad poster', text: 'No image' }));
  assert.equal(invalidPoster.response.status, 400);
  const login = await request(app.base, '/api/admin/login', json('POST', { password: PASSWORD }));
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
  const queue = await request(app.base, '/api/admin/posts', { headers: { Cookie: cookie } });
  assert.deepEqual(queue.body.posts.map((post) => post.category).sort(), ['memes', 'news', 'posters']);
  const approved = await request(app.base, `/api/admin/posts/${queue.body.posts[0].id}`, json('PATCH', { status: 'approved' }, { Cookie: cookie }));
  assert.equal(approved.response.status, 200);
  assert.equal((await request(app.base, '/api/posts')).body.posts.length, 1);
});
