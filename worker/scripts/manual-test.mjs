// Two-window manual test for Hilltoppers Study.
//
//   node scripts/manual-test.mjs https://<your-worker>.workers.dev
//
// The script drives the Worker API end to end (two accounts, invite, accept)
// so a broken deploy is obvious before you open a browser. Screen share and the
// PeerJS handshake still need two real windows; follow the checklist it prints.

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/manual-test.mjs https://<your-worker>.workers.dev');
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function register() {
  const { status, data } = await call('/register', { method: 'POST', body: {} });
  return { status, ...data };
}

console.log('Hilltoppers Study manual API test against ' + base + '\n');

try {
  const health = await call('/health');
  check('worker is reachable and configured', health.status === 200 && health.data.ok === true,
    `status ${health.status}`);

  const a = await register();
  const b = await register();
  check('two accounts created', a.status === 201 && b.status === 201 && a.handle && b.handle,
    `A=${a.handle} B=${b.handle}`);
  check('handles are 6 characters and differ',
    a.handle?.length === 6 && b.handle?.length === 6 && a.handle !== b.handle);

  const lookup = await call('/lookup?handle=' + b.handle, { token: a.token });
  check('A can look up B by code', lookup.status === 200 && lookup.data.peerId === b.peerId);

  const self = await call('/lookup?handle=' + a.handle, { token: a.token });
  check('a student cannot look up their own code', self.status === 400);

  const session = await call('/session', { method: 'POST', body: { handle: b.handle }, token: a.token });
  check('A creates a room inviting B', session.status === 201 && session.data.state === 'waiting',
    `code ${session.data.code}`);

  const bView = await call('/session', { token: b.token });
  check('B sees the invite as pending', bView.status === 200 && bView.data.state === 'invited');
  check('the invite points at A', bView.data.peer === a.peerId);

  const accepted = await call('/session/accept', { method: 'POST', body: { id: session.data.id }, token: b.token });
  check('B accepts, room becomes ready', accepted.status === 200 && accepted.data.state === 'ready');
  check('B is told to connect to A', accepted.data.peer === a.peerId);

  const aView = await call('/session', { token: a.token });
  check('A sees the room ready and B as the peer', aView.data.state === 'ready' && aView.data.peer === b.peerId);

  const stranger = await register();
  const blocked = await call('/session/accept', { method: 'POST', body: { id: session.data.id }, token: stranger.token });
  check('a third account cannot accept someone else\'s invite', blocked.status === 404);

  const ended = await call('/session/end', { method: 'POST', body: {}, token: a.token });
  check('A ends the room', ended.status === 200);
  const after = await call('/session', { token: b.token });
  check('B no longer has an active room', after.data.state === 'none');

  // Relay credentials are optional; report which mode is active rather than
  // failing, so this test is useful before and after TURN is switched on.
  const turn = await call('/turn');
  const servers = turn.data.iceServers || [];
  if (turn.status !== 200) {
    check('relay credentials endpoint responds', false, `status ${turn.status}`);
  } else if (servers.length) {
    // STUN alone cannot cross a school firewall, so insist on a relay entry.
    const hasTurn = JSON.stringify(servers).includes('"turn:') ||
      JSON.stringify(servers).includes('"turns:');
    check('relay (TURN) is configured', true, `${servers.length} ice server group(s)`);
    check('relay includes a TURN url, not just STUN', hasTurn);
  } else if (turn.data.reason) {
    // The Worker refused a half-configured relay. Surface its explanation
    // instead of the generic note: it names the secret that needs fixing.
    check('relay (TURN) is configured', false, turn.data.reason);
  } else {
    console.log('NOTE  relay (TURN) is not configured — fine on an open network,');
    console.log('      but screen sharing will fail on a network that blocks peer-to-peer.');
  }
} catch (error) {
  check('test run completed', false, error.message);
}

console.log(`
${failures === 0 ? 'All API checks passed.' : failures + ' check(s) failed.'}

Now verify the real experience with two windows:

1. Deploy the Worker and the site, and set window.STUDYSTREAM_API in config.js
   to the Worker URL. Open the site in two browser profiles or one private
   window, so each has its own account.
2. Window 1: copy the code it shows. Window 2: enter that code and press Study
   together. Window 1 gets the invite — click Accept. Chat should connect.
3. In one window click Share screen, confirm the consent box, pick a tab, and
   check the other window shows it. Press Stop; the other window's view clears.
4. To check it inside Hilltoppers: add the site as a preview Topping
   (Topping Bar -> Preview a Topping) and repeat steps 1-3. Screen share only
   works if the extension embeds Toppings with allow="display-capture".
`);
process.exit(failures === 0 ? 0 : 1);
