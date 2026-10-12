import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const PASSWORD = 'correct horse battery';

async function setup(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'protest-wall-'));
  const server = createApp({ dataDir, adminPassword: PASSWORD, loginLimit: 50, ...options });
  await server.ready;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { server, dataDir, base, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  let body = null;
  if (response.headers.get('content-type')?.includes('json')) body = await response.json();
  else body = await response.text();
  return { response, body };
}

function jsonOptions(method, body, extra = {}) {
  return { method, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) };
}

async function login(base) {
  const result = await request(base, '/api/admin/login', jsonOptions('POST', { password: PASSWORD }));
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie').split(';', 1)[0];
}

test('pending submissions are private and approved posts are public', async (t) => {
  const app = await setup();
  t.after(app.close);
  const submitted = await request(app.base, '/api/posts', jsonOptions('POST', {
    type: 'text', title: 'A post', text: 'A message', author: 'Reader', satire: false,
  }));
  assert.equal(submitted.response.status, 201);
  assert.deepEqual((await request(app.base, '/api/posts')).body, { posts: [] });
  const cookie = await login(app.base);
  const all = await request(app.base, '/api/admin/posts', { headers: { Cookie: cookie } });
  assert.equal(all.response.status, 200);
  assert.equal(all.body.posts.length, 1);
  const id = submitted.body.id;
  const approved = await request(app.base, `/api/admin/posts/${id}`, jsonOptions('PATCH', { status: 'approved', }, { Cookie: cookie }));
  assert.equal(approved.response.status, 200);
  assert.equal((await request(app.base, '/api/posts')).body.posts[0].id, id);
  const removed = await request(app.base, `/api/admin/posts/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(removed.response.status, 200);
  assert.deepEqual((await request(app.base, '/api/posts')).body, { posts: [] });
});

test('authentication, session state, CSRF and persistence work across instances', async (t) => {
  const app = await setup();
  let appClosed = false;
  t.after(() => appClosed ? undefined : app.close());
  assert.deepEqual((await request(app.base, '/api/admin/session')).body, { authenticated: false, configured: true });
  const bad = await request(app.base, '/api/admin/login', jsonOptions('POST', { password: 'wrong password' }));
  assert.equal(bad.response.status, 401);
  const cookie = await login(app.base);
  assert.deepEqual((await request(app.base, '/api/admin/session', { headers: { Cookie: cookie } })).body, { authenticated: true, configured: true });
  const csrf = await request(app.base, '/api/admin/config', jsonOptions('PUT', { summary: '', demands: [], sourceUrl: '', confirmed: false, }, { Cookie: cookie, Origin: 'https://attacker.example' }));
  assert.equal(csrf.response.status, 403);
  const config = { summary: 'A documented summary', demands: [{ title: 'Demand one', detail: 'Details' }], sourceUrl: 'https://example.com/source', confirmed: true };
  const saved = await request(app.base, '/api/admin/config', jsonOptions('PUT', config, { Cookie: cookie, Origin: app.base }));
  assert.deepEqual(saved.body.config, config);
  await app.close();
  appClosed = true;
  const second = createApp({ dataDir: app.dataDir, adminPassword: PASSWORD });
  await second.ready;
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => second.close(resolve)));
  const secondBase = `http://127.0.0.1:${second.address().port}`;
  assert.deepEqual((await request(secondBase, '/api/config')).body, { config });
});

test('validates public URLs, required fields, body size and static traversal', async (t) => {
  const app = await setup();
  t.after(app.close);
  const badVideo = await request(app.base, '/api/posts', jsonOptions('POST', { type: 'video', title: 'Video', url: 'https://example.com/video', satire: false }));
  assert.equal(badVideo.response.status, 400);
  const privateImage = await request(app.base, '/api/posts', jsonOptions('POST', { type: 'image', title: 'Image', url: 'https://127.0.0.1/image.png', satire: false }));
  assert.equal(privateImage.response.status, 400);
  const missingText = await request(app.base, '/api/posts', jsonOptions('POST', { type: 'text', title: 'No text', satire: false }));
  assert.equal(missingText.response.status, 400);
  const huge = await request(app.base, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(70000) }) });
  assert.equal(huge.response.status, 413);
  const traversal = await request(app.base, '/../server.mjs');
  assert.equal(traversal.response.status, 404);
});

test('admin config confirmation rules and logout', async (t) => {
  const app = await setup();
  t.after(app.close);
  const cookie = await login(app.base);
  const invalid = await request(app.base, '/api/admin/config', jsonOptions('PUT', { summary: 'Needs source', demands: [], sourceUrl: '', confirmed: true }, { Cookie: cookie }));
  assert.equal(invalid.response.status, 400);
  const loggedOut = await request(app.base, '/api/admin/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(loggedOut.response.status, 200);
  const forbidden = await request(app.base, '/api/admin/posts', { headers: { Cookie: cookie } });
  assert.equal(forbidden.response.status, 401);
});

test('a pasted link is classified and stays pending until approved', async (t) => {
  const app = await setup();
  t.after(app.close);
  const cases = [
    ['https://youtu.be/dQw4w9WgXcQ', 'video', 'youtube'],
    ['https://x.com/someone/status/123456789', 'video', 'x'],
    ['https://twitter.com/someone/status/123456789', 'video', 'x'],
    ['https://www.reddit.com/r/example/comments/abc123/a_post/', 'video', 'reddit'],
    ['https://redd.it/abc123', 'video', 'reddit'],
    ['https://example.com/poster.png', 'image', 'image'],
    ['https://news.example.com/story/123', 'text', 'article'],
  ];
  for (const [url, type, platform] of cases) {
    const result = await request(app.base, '/api/posts', jsonOptions('POST', { url }));
    assert.equal(result.response.status, 201, url);
  }
  assert.deepEqual((await request(app.base, '/api/posts')).body.posts, []);
  const cookie = await login(app.base);
  const pending = (await request(app.base, '/api/admin/posts', { headers: { Cookie: cookie } })).body.posts;
  assert.equal(pending.length, cases.length);
  for (const [url, type, platform] of cases) {
    const post = pending.find((item) => item.url === url);
    assert.ok(post, url);
    assert.equal(post.type, type);
    assert.equal(post.platform, platform);
    assert.equal(post.status, 'pending');
    assert.ok(post.title);
  }
  const approval = await request(app.base, `/api/admin/posts/${pending[0].id}`, jsonOptions('PATCH', { status: 'approved' }, { Cookie: cookie }));
  assert.equal(approval.response.status, 200);
  assert.equal((await request(app.base, '/api/posts')).body.posts.length, 1);
});

test('URL and HTML boundaries reject unsafe submissions without fetching remote pages', async (t) => {
  const app = await setup();
  t.after(app.close);
  const bad = [
    { url: 'http://example.com/article' },
    { url: 'https://localhost/article' },
    { url: 'https://127.0.0.1/article' },
    { url: 'https://[::1]/article' },
    { url: 'https://user:pass@example.com/article' },
    { url: 'https://example.com:8443/article' },
    { url: '<iframe src="https://example.com"></iframe>' },
    { url: 'https://youtube.com/watch?v=invalid' },
    { url: 'https://x.com/user/profile' },
    { url: 'https://reddit.com/r/example' },
    { url: 'https://example.com/article', title: '<img src=x onerror=alert(1)>' },
    { url: 'https://example.com/article', embed: '<iframe></iframe>' },
  ];
  for (const input of bad) {
    const result = await request(app.base, '/api/posts', jsonOptions('POST', input));
    assert.equal(result.response.status, 400, JSON.stringify(input));
  }
  assert.deepEqual((await request(app.base, '/api/posts')).body.posts, []);
});

test('production origin works behind a TLS proxy and sets a Secure session cookie', async (t) => {
  const app = await setup({ publicOrigin: 'https://wall.example.org' });
  t.after(app.close);
  const blocked = await request(app.base, '/api/admin/login', jsonOptions('POST', { password: PASSWORD }, { Origin: 'http://wall.example.org' }));
  assert.equal(blocked.response.status, 403);
  const accepted = await request(app.base, '/api/admin/login', jsonOptions('POST', { password: PASSWORD }, { Origin: 'https://wall.example.org' }));
  assert.equal(accepted.response.status, 200);
  assert.match(accepted.response.headers.get('set-cookie'), /; Secure; SameSite=Strict/);
  const crossSite = await request(app.base, '/api/posts', jsonOptions('POST', { url: 'https://example.com/story' }, { 'Sec-Fetch-Site': 'cross-site' }));
  assert.equal(crossSite.response.status, 403);
  assert.deepEqual((await request(app.base, '/health')).body, { status: 'ok' });
  assert.equal((await request(app.base, '/api/unknown')).response.status, 404);
});

test('failed persistence does not publish a post and the next write can recover', async (t) => {
  const app = await setup();
  t.after(app.close);
  await fs.mkdir(path.join(app.dataDir, 'store.json'));
  const first = await request(app.base, '/api/posts', jsonOptions('POST', { url: 'https://example.com/first' }));
  assert.equal(first.response.status, 500);
  assert.deepEqual((await request(app.base, '/api/posts')).body.posts, []);
  await fs.rmdir(path.join(app.dataDir, 'store.json'));
  const second = await request(app.base, '/api/posts', jsonOptions('POST', { url: 'https://example.com/second' }));
  assert.equal(second.response.status, 201);
  const cookie = await login(app.base);
  const all = (await request(app.base, '/api/admin/posts', { headers: { Cookie: cookie } })).body.posts;
  assert.equal(all.length, 1);
  assert.equal(all[0].url, 'https://example.com/second');
});

test('simultaneous submissions persist without losing entries across restart', async (t) => {
  const app = await setup({ submissionLimit: 30 });
  const submitted = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    request(app.base, '/api/posts', jsonOptions('POST', { url: `https://example.com/story/${index}` }))));
  assert.ok(submitted.every(({ response }) => response.status === 201));
  await app.close();
  const second = createApp({ dataDir: app.dataDir, adminPassword: PASSWORD });
  await second.ready;
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => second.close(resolve)));
  const cookie = await login(`http://127.0.0.1:${second.address().port}`);
  const base = `http://127.0.0.1:${second.address().port}`;
  const all = (await request(base, '/api/admin/posts', { headers: { Cookie: cookie } })).body.posts;
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map((post) => post.url)).size, 10);
  assert.deepEqual((await request(base, '/api/posts')).body.posts, []);
});
