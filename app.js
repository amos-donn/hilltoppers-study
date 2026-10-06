// Hilltoppers Study client for the Hilltoppers Topping Bar.
// The Topping runs in a sandboxed iframe and reports its height back to the
// extension through resize.js. Signing in goes through the Hilltoppers Firebase
// project; study-hall presence and room authorization go through the Worker's
// /api routes. PeerJS carries the WebRTC handshake. Chat is an RTCDataChannel
// and screen sharing uses getDisplayMedia; neither ever passes through the
// Worker.
//
// The iframe is sandboxed without allow-modals, so window.confirm/alert do not
// work here; the confirmations below are in-page overlays.
(() => {
  const Peer = window.Peer;
  const API_BASE = (window.STUDYSTREAM_API || '').replace(/\/+$/, '');
  const PEER_OPTIONS = window.STUDYSTREAM_PEER || {};
  // The Topping runs inside the extension's popup iframe; the same page opened
  // as its own tab is not embedded. Only the floating chat distinguishes the
  // two, because a chat box dragged over the shared picture is in the way on a
  // 318px popup and useful on a full window.
  const EMBEDDED = window.parent !== window;
  const FIREBASE = window.STUDYSTREAM_FIREBASE || {};
  const STUDENT_DOMAIN = 'student.stjacademy.org';
  const MAX_MESSAGE = 4000;
  const STORE_KEY = 'hilltoppers-study.account.v1';
  const WARNED_KEY = 'hilltoppers-study.warned';
  const BLOCKS = ['A', 'B', 'C', 'D', 'E', 'CP'];

  const $ = (id) => document.getElementById(id);
  const views = {
    offline: $('view-offline'), signin: $('view-signin'), home: $('view-home'),
    settings: $('settings'), waiting: $('view-waiting'), session: $('view-session')
  };
  const statusDot = $('status-dot');
  const settingsToggle = $('settings-toggle');
  const homeError = $('home-error');
  const signinError = $('signin-error');

  const state = {
    view: null, token: null, profile: null, directory: null,
    peer: null, conn: null, session: null,
    localStream: null, remoteStream: null, call: null, pollTimer: null,
    consentGiven: false, stoppingShare: false, filling: false
  };

  // localStorage throws in a sandboxed frame; never let that break the app.
  function readStore(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch { /* no persistence here */ }
  }
  function removeStore(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // Binds a click only if the element is there. A copy of this file running
  // against markup it does not match — a half-propagated deploy, or a browser
  // holding a stale script — must not be able to blank the Topping, so nothing
  // below the sign-in view is allowed to assume an element exists.
  function on(id, handler) {
    const element = $(id);
    if (element) element.onclick = handler;
  }

  // Settings is a view, so opening it is an ordinary view change and leaving it
  // means going back to whatever is true by then: an invite can land while it is
  // open, and polling keeps state.session current, so the room wins over home.
  function openSettings() {
    showView('settings');
  }

  function leaveSettings() {
    if (state.session) return void renderSession();
    return void renderHome();
  }

  function showView(name) {
    // A view this markup does not have — a stale script against newer markup,
    // or the reverse — must not leave the Topping showing nothing, which is
    // exactly what naming a missing view would do.
    if (!views[name] && views.home) name = 'home';
    state.view = name;
    // Nothing to configure before signing in.
    if (settingsToggle) {
      settingsToggle.hidden = !state.profile;
      settingsToggle.setAttribute('aria-expanded', String(name === 'settings'));
    }
    for (const [key, element] of Object.entries(views)) {
      if (element) element.hidden = key !== name;
    }
  }

  // The top bar is a dot and a gear now. The words that used to sit beside the
  // dot live in its label, so the state is still readable on hover and to a
  // screen reader without putting text in the toolbar.
  //
  // This touches nothing but the dot, and that is the whole point: an earlier
  // version also wrote to a status *text* element, which threw the moment that
  // element was removed — killing boot() before it could show a view and
  // leaving a student staring at nothing but the dot.
  function setStatus(kind, text) {
    if (!statusDot) return;
    statusDot.className = 'dot ' + kind;
    statusDot.title = text;
    statusDot.setAttribute('aria-label', text);
  }

  function showError(message) {
    homeError.textContent = message || '';
    homeError.hidden = !message;
  }

  async function api(path, options = {}) {
    if (!API_BASE) throw new Error('Hilltoppers Study is not configured.');
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const response = await fetch(API_BASE + '/api' + path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function addMessage(text, who, mine) {
    const node = $('message-template').content.firstElementChild.cloneNode(true);
    node.classList.toggle('mine', Boolean(mine));
    node.classList.toggle('system', !who);
    node.querySelector('.who').textContent = who || '';
    node.querySelector('.text').textContent = text;
    $('messages').append(node);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  const system = (text) => addMessage(text, '', false);

  // -- Sign in with Hilltoppers ------------------------------------------
  // The same Firebase project the extension signs in against, so a student
  // keeps the same email and password. Study creates nothing and resets
  // nothing; it only exchanges the password for a token.
  function firebaseUrl(method) {
    return `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(FIREBASE.apiKey || '')}`;
  }

  async function hilltoppersSignIn(email, password) {
    const response = await fetch(firebaseUrl('signInWithPassword'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data?.error?.message || '';
      if (code === 'EMAIL_NOT_FOUND') throw new Error('No Hilltoppers account with that email.');
      if (code === 'INVALID_LOGIN_CREDENTIALS' || code === 'INVALID_PASSWORD') throw new Error('Incorrect email or password.');
      if (code === 'USER_DISABLED') throw new Error('That account is disabled.');
      if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new Error('Too many attempts. Try again in a few minutes.');
      throw new Error('Could not sign in. Check the connection and try again.');
    }
    return data.idToken;
  }

  function isStudentEmail(email) {
    return new RegExp('^[^@\\s]+@' + STUDENT_DOMAIN.replace(/\./g, '\\.') + '$', 'i').test(email);
  }

  async function signInWithToken(idToken) {
    const result = await api('/auth', { method: 'POST', body: JSON.stringify({ idToken }) });
    state.token = result.token;
    state.profile = result;
    writeStore(STORE_KEY, JSON.stringify({ token: result.token }));
  }

  // -- Profile and study hall --------------------------------------------
  function renderProfile() {
    const profile = state.profile;
    if (!profile) return;
    $('my-name').textContent = profile.name;
    $('my-context').textContent = contextLine(profile);
    if ($('settings-email')) $('settings-email').textContent = profile.email;
    renderBlockPicker(profile.studyBlocks || []);
    renderStudents();
  }

  function contextLine(profile) {
    if (profile.block) {
      const where = profile.studyBlocks?.includes(profile.block.letter) ? 'Study hall' : 'In class';
      return `${profile.dayType} · ${profile.block.name} ${formatRange(profile.block)} · ${where}`;
    }
    if (profile.dayType === 'No School') return 'No school today.';
    if (profile.availability === 'after-school') return `${profile.dayType} · After school.`;
    return profile.dayType || '';
  }

  function formatRange(block) {
    return `${formatTime(block.start)}-${formatTime(block.end)}`;
  }

  // Times arrive as 24-hour "HH:MM"; show them the way a student reads a
  // schedule. Noon and midnight are the two that trip a naive conversion.
  function formatTime(value) {
    const [hour, minute] = String(value).split(':').map(Number);
    const suffix = hour < 12 ? 'am' : 'pm';
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display}:${String(minute).padStart(2, '0')}${suffix}`;
  }

  function renderBlockPicker(selected) {
    const picker = $('block-picker');
    picker.replaceChildren();
    for (const letter of BLOCKS) {
      const label = document.createElement('label');
      label.className = 'block';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = letter;
      input.checked = selected.includes(letter);
      input.onchange = saveBlocks;
      const text = document.createElement('span');
      text.textContent = letter;
      label.append(input, text);
      picker.append(label);
    }
  }

  async function saveBlocks() {
    const blocks = [...$('block-picker').querySelectorAll('input:checked')].map((input) => input.value);
    try {
      state.profile = await api('/profile', { method: 'POST', body: JSON.stringify({ blocks }) });
      renderProfile();
      $('blocks-note').textContent = blocks.length
        ? 'Saved. Your name shows to classmates during ' + blocks.join(', ') + '.'
        : 'Tick the blocks you have study hall. Your name shows to classmates during those blocks.';
    } catch (error) {
      showError(error.message);
    }
  }

  // -- Who is free to study ----------------------------------------------
  function renderStudents() {
    const data = state.directory;
    const list = $('student-list');
    const note = $('list-note');
    list.replaceChildren();
    if (!data) { note.hidden = false; note.textContent = 'Loading…'; return; }

    const mine = state.profile?.email;
    const others = (data.students || []).filter((student) => student.email !== mine);
    const shown = data.mode === 'during-school'
      ? others.filter((student) => student.available)
      : others.filter((student) => student.freeNow);

    if (data.mode === 'during-school') {
      $('list-label').textContent = data.block
        ? `Free in ${data.block.name}`
        : 'Free to study now';
      note.textContent = shown.length
        ? 'Tap a name to ask them to study.'
        : 'No one else is free in this block yet.';
    } else if (data.mode === 'after-school') {
      $('list-label').textContent = 'Free to study';
      note.textContent = shown.length
        ? 'School is out. Tap a name to study, or type an email below.'
        : 'School is out. Type a classmate\'s email below to study.';
    } else {
      $('list-label').textContent = 'Free to study';
      note.textContent = shown.length
        ? 'No school today. Tap a name to study, or type an email below.'
        : 'No school today. Type a classmate\'s email below to study.';
    }
    note.hidden = shown.length > 0;

    for (const student of shown) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'student';
      const name = document.createElement('span');
      name.className = 'student-name';
      name.textContent = student.name;
      const where = document.createElement('span');
      where.className = 'student-where';
      where.textContent = data.mode === 'during-school'
        ? student.blocks.join(', ')
        : 'Study hall ' + student.blocks.join(', ');
      row.append(name, where);
      row.onclick = () => inviteByEmail(student.email, student.name);
      list.append(row);
    }
  }

  async function refreshDirectory() {
    try {
      state.directory = await api('/students');
      renderStudents();
    } catch { /* transient; the list keeps its last state */ }
  }

  // -- Invites -----------------------------------------------------------
  async function inviteByEmail(email, name) {
    showError('');
    if (!isStudentEmail(email)) {
      return showError('Use a school email like firstname.lastname@student.stjacademy.org.');
    }
    if (email === state.profile?.email) return showError('That is your own email.');
    try {
      state.session = await api('/session', { method: 'POST', body: JSON.stringify({ email }) });
      if (!state.session.withName && name) state.session.withName = name;
      renderSession();
      startPolling();
    } catch (error) {
      showError(error.message);
    }
  }

  // -- PeerJS ------------------------------------------------------------
  // Merge relay servers from the Worker with anything set in config.js, so a
  // static TURN server can be used before the Worker one is configured.
  async function peerOptions() {
    const base = { ...PEER_OPTIONS };
    if (base.config?.iceServers?.length) return base;
    try {
      const relay = await api('/turn');
      // Only adopt a list that can actually relay. Replacing the defaults with
      // STUN alone would drop the peer-to-peer fallback and change nothing on a
      // network that blocks it, so the failure would look identical either way.
      if (canRelay(relay?.iceServers)) {
        base.config = { ...(base.config || {}), iceServers: relay.iceServers };
      }
    } catch { /* no relay: fall back to the public cloud */ }
    return base;
  }

  // Mirrors the Worker's check. A turn:/turns: url with credentials is the only
  // thing that gets through a network which blocks peer-to-peer; STUN alone
  // cannot, so it is not worth trading the working defaults for.
  function canRelay(iceServers) {
    if (!Array.isArray(iceServers)) return false;
    return iceServers.some((server) => {
      if (!server || typeof server !== 'object') return false;
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const hasTurn = urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()));
      return hasTurn && Boolean(server.username || server.credential);
    });
  }

  async function ensurePeer() {
    if (state.peer && !state.peer.destroyed) return state.peer;
    const options = await peerOptions();
    return new Promise((resolve, reject) => {
      const peer = new Peer(state.profile.peerId, options);
      peer.on('open', () => { state.peer = peer; resolve(peer); });
      peer.on('error', (error) => {
        if (!state.peer) reject(error);
        else system('Connection problem: ' + (error.type || 'error'));
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* ignore */ } });
      peer.on('connection', wireConn);
      peer.on('call', (call) => { call.answer(); wireCall(call, false); });
    });
  }

  // Only the guest dials and only the host answers, so exactly one channel and
  // one call exist per session.
  async function connectPeer() {
    const session = state.session;
    try {
      await ensurePeer();
    } catch {
      system('Could not reach the connection service. Reload the Topping.');
      return;
    }
    if (!session?.peer) return;
    if (session.role === 'guest') {
      if (state.conn?.open) return;
      wireConn(state.peer.connect(session.peer, { label: 'hilltoppers-study-chat', reliable: true }));
    }
    system('Connecting…');
  }

  function wireConn(conn) {
    if (state.conn && state.conn.open && state.conn !== conn) { try { conn.close(); } catch { /* ignore */ } return; }
    state.conn = conn;
    conn.on('open', () => { system('Connected. Say hello.'); setStatus('online', 'Connected'); });
    conn.on('data', (data) => {
      if (data?.t === 'chat' && typeof data.text === 'string') {
        addMessage(data.text.slice(0, MAX_MESSAGE), data.name || 'Classmate', false);
      }
    });
    conn.on('close', () => { system('Your classmate disconnected.'); });
    conn.on('error', () => { system('The chat connection failed.'); });
  }

  // outgoing is true for the classmate sharing, false for the one watching. The
  // two need different wording, and only the watcher should log to the chat.
  function wireCall(call, outgoing) {
    state.call = call;
    let connected = false;
    // The caller never receives its own stream back, so it has to judge success
    // from the peer connection itself. Waiting for 'stream' here would time out
    // on a share that is working perfectly.
    call.on('stream', (stream) => {
      connected = true;
      state.remoteStream = stream;
      renderVideo();
    });
    const markConnected = () => {
      // A media path that is already up succeeds on the spot, however late we look.
      if (call.peerConnection?.connectionState === 'connected') connected = true;
    };
    call.on('close', () => {
      markConnected();
      // A stop we asked for is not a failure, so stay quiet about it.
      const stopped = state.stoppingShare;
      clearRemote();
      if (stopped) return;
      if (outgoing) {
        $('share-status').textContent = connected
          ? 'Your classmate stopped watching.'
          : 'The screen connection could not be made.';
      } else if (connected) {
        system('Your classmate stopped sharing.');
      }
    });
    call.on('error', () => {
      markConnected();
      clearRemote();
      if (outgoing) {
        $('share-status').textContent = connected
          ? 'Your classmate stopped watching.'
          : 'The screen connection could not be made.';
      } else {
        system('The screen connection could not be made.');
      }
    });
    // A call that never opens at all would otherwise hang silently.
    if (outgoing) {
      setTimeout(() => {
        if (state.call === call) markConnected();
        if (state.call === call && !connected) {
          $('share-status').textContent = 'The screen connection could not be made.';
        }
      }, 20000);
    }
  }

  function clearRemote() {
    state.remoteStream = null;
    state.call = null;
    renderVideo();
  }

  // Show the classmate's screen. Your own picture is never mirrored back to you:
  // you already have the window you are sharing, so while you share and are not
  // watching anything, the box says so instead.
  function renderVideo() {
    const sharing = Boolean(state.localStream);
    const stream = state.remoteStream;
    const showMessage = sharing && !stream;
    const video = $('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    $('video-wrap').hidden = !sharing && !stream;
    $('video-message').hidden = !showMessage;
    $('video-label').hidden = !stream;
    // Fill tab stretches the picture over the page rather than using the
    // Fullscreen API, so it works in the embed too.
    $('video-full').hidden = !sharing && !stream;
    if (stream) {
      $('video-label').textContent = "Classmate's screen";
      // A paused element paints black: the stream is there, but nothing renders
      // it. autoplay covers the first stream; this covers swapping between two.
      video.play().catch(() => { /* autoplay may be blocked; the frame stays */ });
    }
    applyFillMode();
  }

  // Enter or leave the in-page fill, and keep the floating chat in step.
  function applyFillMode() {
    const filling = state.filling && Boolean(state.remoteStream || state.localStream);
    if (!filling) state.filling = false;
    // Fill mode hides the chat. Floating it back over the picture is for the
    // site opened as its own page; inside the Topping that draggable box sits on
    // the thing being watched, so there the chat simply stays hidden.
    const floating = filling && !EMBEDDED;
    $('app').classList.toggle('filling', filling);
    $('chat-float').hidden = !floating;
    $('video-full').textContent = filling ? 'Exit' : 'Fill tab';
    // Start each fill anchored to the corner; a drag within a fill is kept.
    if (!filling) {
      const panel = $('chat-float');
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
    }
    mountChat(floating);
    if (filling) $('video').play().catch(() => { /* autoplay may be blocked; the frame stays */ });
  }

  // While filling, the chat is a floating panel, so the conversation and the
  // composer move into it and back out again. Same nodes: one conversation.
  function mountChat(filling) {
    const session = $('view-session');
    const messages = $('messages');
    const form = $('chat-form');
    if (filling) {
      $('chat-float-body').append(messages, form);
      return;
    }
    // Back above the floating panel, which sits where they originally were.
    const anchor = $('chat-float');
    session.insertBefore(messages, anchor);
    session.insertBefore(form, anchor);
  }

  // -- Screen sharing ----------------------------------------------------
  async function startShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      $('share-status').textContent = 'Screen sharing is not available here.';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      state.localStream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', stopShare);
      $('share').hidden = true;
      $('stop-share').hidden = false;
      $('share-status').textContent = 'Sharing your screen';
      renderVideo();
      // Send the screen to the classmate only if we are already connected.
      if (state.conn?.open && state.peer && state.session?.peer) {
        state.stoppingShare = false;
        wireCall(state.peer.call(state.session.peer, stream, { metadata: { kind: 'screen' } }), true);
      } else {
        $('share-status').textContent = 'Not connected yet. The screen could not be sent.';
      }
    } catch (error) {
      $('share-status').textContent = error?.name === 'NotAllowedError'
        ? 'Screen sharing is blocked here. Ask to have it enabled in Hilltoppers.'
        : 'Screen sharing was cancelled.';
    }
  }

  function stopShare() {
    // Mark it before closing, so wireCall knows the close was intended and stays
    // quiet instead of reporting a failure.
    state.stoppingShare = true;
    for (const track of state.localStream?.getTracks() || []) track.stop();
    state.localStream = null;
    try { state.call?.close(); } catch { /* already closed */ }
    clearRemote();
    $('share').hidden = false;
    $('stop-share').hidden = true;
    $('share-status').textContent = '';
  }

  // -- Sessions ----------------------------------------------------------
  async function refreshSession() {
    const session = await api('/session');
    if (session.state === 'none') {
      if (state.session) await leave();
      return;
    }
    state.session = session;
    renderSession();
  }

  function renderSession() {
    const session = state.session;
    $('end').hidden = false;
    if (session.state === 'waiting') {
      showView('waiting');
      $('accept-slot').replaceChildren();
      $('waiting-heading').textContent = 'Waiting for a classmate';
      $('waiting-name').textContent = session.withName || '';
      $('waiting-note').textContent = session.withName
        ? `Waiting for ${session.withName} to accept.`
        : 'Waiting for your classmate to accept.';
      setStatus('waiting', 'Waiting for classmate');
      return;
    }
    if (session.state === 'invited') {
      showView('waiting');
      $('waiting-heading').textContent = 'Study invite';
      $('waiting-name').textContent = session.withName || 'A classmate';
      $('waiting-note').textContent = 'Accept to start your session.';
      $('accept-slot').replaceChildren(makeAcceptButton(session));
      setStatus('waiting', 'Invite pending');
      return;
    }
    // ready
    showView('session');
    $('accept-slot').replaceChildren();
    $('share').hidden = false;
    setStatus('online', 'Connected');
    connectPeer();
    startPolling();
  }

  function makeAcceptButton(session) {
    const wrapper = document.createElement('div');
    wrapper.className = 'row end';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.textContent = 'Accept invite';
    button.onclick = async () => {
      try {
        state.session = await api('/session/accept', { method: 'POST', body: JSON.stringify({ id: session.id }) });
        renderSession();
      } catch (error) { showError(error.message); }
    };
    wrapper.append(button);
    return wrapper;
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (state.conn?.open) return;
      try { await refreshSession(); } catch { /* transient; try again */ }
    }, 2000);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function leave() {
    state.session = null;
    state.conn = null;
    stopPolling();
    stopShare();
    state.filling = false;
    applyFillMode();
    $('end').hidden = true;
    $('share').hidden = true;
    $('accept-slot').replaceChildren();
    $('messages').replaceChildren();
    showView('home');
    setStatus('online', 'Ready');
    refreshDirectory();
  }

  async function renderHome() {
    renderProfile();
    showView('home');
    // Watch for an invite even before we start one, so a classmate who asks us
    // can pull us into a session.
    startPolling();
    refreshDirectory();
  }

  // The blocks are edited in Settings, so a student who has not picked any yet
  // is taken straight there instead of being left on a home view that cannot
  // explain why their name never shows up for anyone. Called on arrival only:
  // putting this inside renderHome would reopen Settings on leaving it.
  function openSettingsIfUnset() {
    if (!(state.profile?.studyBlocks || []).length) openSettings();
  }

  // -- Events ------------------------------------------------------------
  $('retry').addEventListener('click', boot);

  $('signin-form').onsubmit = async (event) => {
    event.preventDefault();
    signinError.hidden = true;
    const email = $('signin-email').value.trim().toLowerCase();
    const password = $('signin-password').value;
    if (!isStudentEmail(email)) {
      signinError.textContent = `Use your @${STUDENT_DOMAIN} school email.`;
      signinError.hidden = false;
      return;
    }
    const button = $('signin-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const idToken = await hilltoppersSignIn(email, password);
      await signInWithToken(idToken);
      $('signin-password').value = '';
      await renderHome();
      openSettingsIfUnset();
    } catch (error) {
      signinError.textContent = error.message;
      signinError.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  };

  $('invite-form').onsubmit = async (event) => {
    event.preventDefault();
    const email = $('invite-email').value.trim().toLowerCase();
    if (!email) return;
    await inviteByEmail(email, '');
    $('invite-email').value = '';
  };

  $('cancel-wait').onclick = async () => {
    try { await api('/session/end', { method: 'POST', body: JSON.stringify({}) }); } catch { /* leaving anyway */ }
    await leave();
  };

  $('end').onclick = async () => {
    try { await api('/session/end', { method: 'POST', body: JSON.stringify({}) }); } catch { /* leaving anyway */ }
    await leave();
  };

  // The account is the school email, so changing it means signing in with the
  // other one: there is no separate address on the account to rewrite.
  function signOut() {
    removeStore(STORE_KEY);
    state.token = null;
    state.profile = null;
    state.directory = null;
    stopPolling();
    try { state.peer?.destroy(); } catch { /* ignore */ }
    state.peer = null;
    showView('signin');
    setStatus('offline', 'Signed out');
  }

  $('sign-out').onclick = () => signOut();

  on('settings-toggle', () => (state.view === 'settings' ? leaveSettings() : openSettings()));
  on('settings-done', () => leaveSettings());
  on('change-email', () => {
    signOut();
    $('signin-email').focus();
  });

  $('chat-form').onsubmit = (event) => {
    event.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (state.conn?.open) {
      state.conn.send({ t: 'chat', name: state.profile?.name || 'Classmate', text: text.slice(0, MAX_MESSAGE) });
      addMessage(text, 'You', true);
    } else {
      system('Not connected yet.');
    }
    $('chat-input').value = '';
  };

  $('share').onclick = () => {
    if (state.consentGiven) return void startShare();
    $('consent').hidden = false;
    $('consent-ok').disabled = !$('consent-check').checked;
  };
  $('consent-check').onchange = () => { $('consent-ok').disabled = !$('consent-check').checked; };
  $('consent-cancel').onclick = () => { $('consent').hidden = true; };
  $('consent-ok').onclick = () => { state.consentGiven = true; $('consent').hidden = true; startShare(); };
  $('stop-share').onclick = stopShare;
  // Fill tab, not the Fullscreen API: the picture is stretched over the page and
  // the chat floats above it.
  $('video-full').onclick = () => {
    state.filling = !state.filling;
    applyFillMode();
  };
  // Drag the floating chat so it does not sit over the part of the picture the
  // viewer needs. Pointer events cover mouse and touch.
  let chatDrag = null;
  let chatDragged = false;
  $('chat-float-toggle').onclick = () => {
    // A drag ends with a click; do not let it also collapse the panel.
    if (chatDragged) { chatDragged = false; return; }
    const body = $('chat-float-body');
    body.hidden = !body.hidden;
    $('chat-float-toggle').setAttribute('aria-expanded', String(!body.hidden));
    $('chat-float-chev').textContent = body.hidden ? '▸' : '▾';
  };
  const chatBar = $('chat-float-toggle');
  chatBar.addEventListener('pointerdown', (event) => {
    const panel = $('chat-float').getBoundingClientRect();
    chatDrag = { offX: event.clientX - panel.left, offY: event.clientY - panel.top, startX: event.clientX, startY: event.clientY };
    chatDragged = false;
    chatBar.setPointerCapture(event.pointerId);
  });
  chatBar.addEventListener('pointermove', (event) => {
    if (!chatDrag) return;
    if (Math.hypot(event.clientX - chatDrag.startX, event.clientY - chatDrag.startY) > 4) chatDragged = true;
    if (!chatDragged) return;
    const panel = $('chat-float');
    const box = $('view-session').getBoundingClientRect();
    const left = Math.min(Math.max(event.clientX - chatDrag.offX - box.left, 0), Math.max(box.width - panel.offsetWidth, 0));
    const top = Math.min(Math.max(event.clientY - chatDrag.offY - box.top, 0), Math.max(box.height - panel.offsetHeight, 0));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  });
  chatBar.addEventListener('pointerup', () => { chatDrag = null; });
  $('warning-ok').onclick = () => { $('warning').hidden = true; writeStore(WARNED_KEY, '1'); };

  // Leaving the page drops a fill that would otherwise be stuck, since the
  // student cannot press Exit from a tab they have navigated away from.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.filling) {
      state.filling = false;
      applyFillMode();
    }
  });

  // -- Boot --------------------------------------------------------------
  async function boot() {
    showError('');
    setStatus('', 'Starting…');
    if (!readStore(WARNED_KEY)) $('warning').hidden = false;
    if (!API_BASE || !FIREBASE.apiKey) {
      showView('offline');
      setStatus('offline', 'Not configured');
      return;
    }
    // A saved token lets a student skip the sign-in form until it expires.
    let saved = null;
    try { saved = JSON.parse(readStore(STORE_KEY) || 'null'); } catch { saved = null; }
    if (saved?.token) {
      state.token = saved.token;
      try {
        state.profile = await api('/profile');
        await renderHome();
        // Before refreshSession, so a room already in progress still wins.
        openSettingsIfUnset();
        try { await refreshSession(); } catch { /* no active session is normal */ }
        return;
      } catch {
        // Expired or rejected: fall through to the sign-in form.
        removeStore(STORE_KEY);
        state.token = null;
        state.profile = null;
      }
    }
    showView('signin');
    setStatus('online', 'Signed out');
  }

  boot();
})();
