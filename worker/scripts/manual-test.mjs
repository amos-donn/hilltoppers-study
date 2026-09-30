// API test for Hilltoppers Study.
//
//   node scripts/manual-test.mjs https://<your-worker>.workers.dev
//
// Signs two throwaway students in against the Hilltoppers Firebase project,
// then drives the Worker API end to end: study-hall blocks, the directory, an
// invite, an accept, and the end. A broken deploy is obvious before a browser
// is opened.
//
// The throwaway accounts are deleted at the end. They are real accounts in the
// Hilltoppers Firebase project for as long as the script runs, so run it
// against a Worker you own, not against production during the school day.
//
// Screen share and the PeerJS handshake still need two real windows.

import crypto from 'node:crypto';

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/manual-test.mjs https://<your-worker>.workers.dev');
  process.exit(1);
}

// The public Hilltoppers web config. Safe to commit: Google publishes it in
// page source, and it is the same project the extension signs in against.
const FIREBASE_KEY = 'AIzaSyCPDKZHahJOA2WIJaOaYDYDcxFNAW2oUK0';
const ORIGIN = 'https://amos-donn.github.io';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function firebase(method, body) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${FIREBASE_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

const created = [];
async function makeStudent(local) {
  const email = `${local}@student.stjacademy.org`;
  const password = crypto.randomBytes(12).toString('base64url');
  const result = await firebase('signUp', { email, password, returnSecureToken: true });
  if (result.status !== 200) throw new Error(`could not create ${email}: ${JSON.stringify(result.data).slice(0, 200)}`);
  created.push(result.data.idToken);
  return { email, password, idToken: result.data.idToken };
}

console.log('Hilltoppers Study API test against ' + base + '\n');

try {
  const health = await call('/health');
  check('the Worker is up and configured', health.status === 200, JSON.stringify(health.data));
  if (health.status !== 200) throw new Error('Worker is not answering /api/health');

  const tag = crypto.randomBytes(3).toString('hex');
  const alice = await makeStudent(`zz-manual-alice-${tag}`);
  const bob = await makeStudent(`zz-manual-bob-${tag}`);

  const aliceAuth = await call('/auth', { method: 'POST', body: { idToken: alice.idToken } });
  check('a student signs in with their Hilltoppers account', aliceAuth.status === 200 && Boolean(aliceAuth.data.token), JSON.stringify(aliceAuth.data).slice(0, 160));
  const aliceToken = aliceAuth.data.token;
  const bobAuth = await call('/auth', { method: 'POST', body: { idToken: bob.idToken } });
  check('a second student signs in', bobAuth.status === 200 && Boolean(bobAuth.data.token));
  const bobToken = bobAuth.data.token;

  const forged = await call('/auth', { method: 'POST', body: { idToken: alice.idToken.slice(0, -4) + 'beef' } });
  check('a forged token is refused', forged.status === 401);

  const blocks = await call('/profile', { method: 'POST', token: aliceToken, body: { blocks: ['A', 'C'] } });
  check('study-hall blocks are saved', blocks.status === 200 && blocks.data.studyBlocks.length === 2, JSON.stringify(blocks.data.studyBlocks));
  await call('/profile', { method: 'POST', token: bobToken, body: { blocks: ['B'] } });

  const students = await call('/students', { token: aliceToken });
  check('the free-to-study list answers', students.status === 200 && Array.isArray(students.data.students), JSON.stringify(students.data).slice(0, 160));
  check('both students are listed', (students.data.students || []).length >= 2);

  const found = await call(`/directory?q=${encodeURIComponent(bob.email)}`, { token: aliceToken });
  check('a classmate is found by email', found.status === 200 && found.data.results.some((r) => r.email === bob.email));

  const self = await call('/session', { method: 'POST', token: aliceToken, body: { email: alice.email } });
  check('inviting yourself is refused', self.status === 400);

  const started = await call('/session', { method: 'POST', token: aliceToken, body: { email: bob.email } });
  check('a session starts', started.status === 201, JSON.stringify(started.data).slice(0, 160));
  check('the session names the classmate', Boolean(started.data.withName));

  const invite = await call('/session', { token: bobToken });
  check('the invited student sees the invite', invite.data.state === 'invited', JSON.stringify(invite.data).slice(0, 160));

  const accepted = await call('/session/accept', { method: 'POST', token: bobToken, body: { id: started.data.id } });
  check('the invite is accepted', accepted.status === 200 && accepted.data.state === 'ready');

  const ready = await call('/session', { token: aliceToken });
  check('both sides are ready to connect', ready.data.state === 'ready');

  const ended = await call('/session/end', { method: 'POST', token: aliceToken, body: {} });
  check('the session ends', ended.status === 200 && ended.data.state === 'none');

  const relay = await call('/turn');
  check('the relay endpoint answers', relay.status === 200, relay.data.configured ? 'configured' : 'not configured (peer-to-peer only)');
} catch (error) {
  failures += 1;
  console.error('\n' + error.message);
} finally {
  for (const idToken of created) await firebase('delete', { idToken });
  if (created.length) console.log(`\nDeleted ${created.length} throwaway Firebase accounts.`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
