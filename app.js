// Hilltoppers Study client for the Hilltoppers Topping Bar.
// The Topping runs in a sandboxed iframe and reports its height back to the
// extension through resize.js. Signing in, code lookup and room authorization
// go through the Worker's /api routes. PeerJS carries the WebRTC handshake.
// Chat is an RTCDataChannel and screen sharing uses getDisplayMedia; neither
// ever passes through the Worker.
//
// The iframe is sandboxed without allow-modals, so window.confirm/alert do not
// work here; the confirmations below are in-page overlays. localStorage is also
// blocked in a sandboxed cross-origin frame, so every access is guarded.
(() => {
  const Peer = window.Peer;
  const API_BASE = (window.STUDYSTREAM_API || '').replace(/\/+$/, '');
  const PEER_OPTIONS = window.STUDYSTREAM_PEER || {};
  const HANDLE_LENGTH = 6;
  const MAX_MESSAGE = 4000;
  const STORE_KEY = 'studystream.account.v1';
  const WARNED_KEY = 'studystream.warned';

  const $ = (id) => document.getElementById(id);
  const views = {
    offline: $('view-offline'), home: $('view-home'),
    waiting: $('view-waiting'), session: $('view-session')
  };
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const homeError = $('home-error');

  const state = {
    token: null, handle: null, peerId: null, session: null,
    peer: null, conn: null, pendingHandle: null,
    localStream: null, remoteStream: null, call: null, pollTimer: null,
    consentGiven: false, stoppingShare: false,
    filling: false
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

  function showView(name) {
    for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
  }

  function setStatus(kind, text) {
    statusDot.className = 'dot ' + kind;
    statusText.textContent = text;
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

  // -- Account -----------------------------------------------------------
  async function signIn() {
    let saved = null;
    try { saved = JSON.parse(readStore(STORE_KEY) || 'null'); } catch { saved = null; }
    let created;
    if (saved?.accountId && saved?.secret) {
      try {
        created = await api('/register', {
          method: 'POST', body: JSON.stringify({ accountId: saved.accountId, secret: saved.secret })
        });
      } catch {
        removeStore(STORE_KEY);
        created = await api('/register', { method: 'POST', body: JSON.stringify({}) });
      }
    } else {
      created = await api('/register', { method: 'POST', body: JSON.stringify({}) });
    }
    if (created.secret) writeStore(STORE_KEY, JSON.stringify({ accountId: created.accountId, secret: created.secret }));
    state.token = created.token;
    state.handle = created.handle;
    state.peerId = created.peerId;
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

  async function ensurePeer() {
    if (state.peer && !state.peer.destroyed) return state.peer;
    const options = await peerOptions();
    return new Promise((resolve, reject) => {
      const peer = new Peer(state.peerId, options);
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
      wireConn(state.peer.connect(session.peer, { label: 'studystream-chat', reliable: true }));
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
    $('app').classList.toggle('filling', filling);
    $('chat-float').hidden = !filling;
    $('video-full').textContent = filling ? 'Exit' : 'Fill tab';
    // Start each fill anchored to the corner; a drag within a fill is kept.
    if (!filling) {
      const panel = $('chat-float');
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
    }
    mountChat(filling);
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
      if (state.pendingHandle) {
        $('waiting-heading').textContent = 'Invite sent';
        $('waiting-code').textContent = state.pendingHandle.split('').join(' ');
        $('waiting-note').textContent = 'Waiting for your classmate to accept.';
      } else {
        $('waiting-heading').textContent = 'Waiting for a classmate';
        $('waiting-code').textContent = (state.handle || '').split('').join(' ');
        $('waiting-note').textContent = 'Share your code, or wait for the classmate you invited to accept.';
      }
      setStatus('waiting', 'Waiting for classmate');
      return;
    }
    if (session.state === 'invited') {
      showView('waiting');
      $('waiting-heading').textContent = 'Study invite';
      $('waiting-code').textContent = 'Someone wants to study';
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
    state.pendingHandle = null;
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
  }

  async function renderHome() {
    $('my-code').textContent = (state.handle || '······').split('').join(' ');
    showView('home');
    // Watch for an invite even before we start one, so a classmate who enters
    // our code can pull us into a session.
    startPolling();
  }

  // -- Events ------------------------------------------------------------
  $('retry').addEventListener('click', boot);

  $('copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.handle || '');
      $('copy-code').textContent = 'Copied';
      setTimeout(() => { $('copy-code').textContent = 'Copy'; }, 1200);
    } catch { /* clipboard may be blocked; the code is readable by hand */ }
  };

  $('share-code').onclick = async () => {
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) await navigator.share({ title: 'Hilltoppers Study', text: 'Study with me on Hilltoppers Study. My code: ' + state.handle });
      else await navigator.clipboard.writeText('Study with me on Hilltoppers Study: ' + url + '  My code: ' + state.handle);
    } catch { /* the classmate can read the code instead */ }
  };

  $('join-form').onsubmit = async (event) => {
    event.preventDefault();
    showError('');
    const handle = $('join-code').value.trim().toUpperCase();
    if (handle.length !== HANDLE_LENGTH) return showError('Enter a 6-character code.');
    try {
      state.session = await api('/session', { method: 'POST', body: JSON.stringify({ handle }) });
      state.pendingHandle = state.session.role === 'host' ? handle : null;
      renderSession();
      startPolling();
    } catch (error) { showError(error.message); }
  };

  $('cancel-wait').onclick = async () => {
    try { await api('/session/end', { method: 'POST', body: JSON.stringify({}) }); } catch { /* leaving anyway */ }
    await leave();
  };

  $('end').onclick = async () => {
    try { await api('/session/end', { method: 'POST', body: JSON.stringify({}) }); } catch { /* leaving anyway */ }
    await leave();
  };

  $('chat-form').onsubmit = (event) => {
    event.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (state.conn?.open) {
      state.conn.send({ t: 'chat', name: state.handle, text: text.slice(0, MAX_MESSAGE) });
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
    setStatus('offline', 'Starting…');
    if (!readStore(WARNED_KEY)) $('warning').hidden = false;
    if (!API_BASE) {
      showView('offline');
      setStatus('offline', 'Not configured');
      return;
    }
    try {
      await signIn();
    } catch {
      showView('offline');
      setStatus('offline', 'Offline');
      return;
    }
    await renderHome();
    try { await refreshSession(); } catch { /* no active session is normal */ }
  }

  boot();
})();
