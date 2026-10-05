// 1:1 video/audio visit over WebRTC. Media goes phone-to-phone (DTLS-SRTP encrypted) or via
// the clinic's TURN relay; our server only relays signalling.
// Protocol: each side posts "ready" when it opens the call (the other replies "here");
// the doctor always creates the offer, the patient answers. A new offer replaces any old
// connection, which also covers reconnects after a network drop.

export function mediaSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
}

export function startCall({ api, cid, role, iceServers, videoWanted, els, onState }) {
  const isCaller = role === 'doctor';
  let pc = null;
  let local = null;
  let lastSeq = -1;
  let stopped = false;
  let pending = []; // ICE candidates that arrive before the remote description
  let gen = 0; // connection generation: answers/candidates of an older offer are ignored
  const early = new Map(); // candidates for an offer that has not arrived yet (HTTP requests may reorder)
  const signal = (type, data = null) => api('POST', `/v1/consultations/${cid}/signal`, { type, data }).catch(() => {});

  function newPeer() {
    if (pc) { try { pc.close(); } catch { /* closed */ } }
    pending = [];
    pc = new RTCPeerConnection({ iceServers });
    for (const t of local.getTracks()) pc.addTrack(t, local);
    const myGen = gen;
    pc.onicecandidate = (e) => { if (e.candidate) signal('ice', { gen: myGen, c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => { if (els.remote.srcObject !== e.streams[0]) els.remote.srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      onState({ connected: 'وصل شد', connecting: 'در حال اتصال…', disconnected: 'اتصال قطع شد؛ تلاش دوباره…', failed: 'اتصال برقرار نشد' }[s] ?? null, s);
      if (s === 'failed' && isCaller && !stopped) setTimeout(() => !stopped && offer(true), 1500);
    };
    return pc;
  }

  async function offer(iceRestart = false) {
    gen++;
    newPeer();
    const o = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(o);
    signal('offer', { gen, sdp: pc.localDescription.sdp, type: pc.localDescription.type });
    onState('در انتظار پاسخ طرف مقابل…', 'calling');
  }

  async function handle(msg) {
    if (msg.type === 'ready') {
      if (isCaller) await offer(); else signal('here');
    } else if (msg.type === 'here') {
      if (isCaller) await offer();
    } else if (msg.type === 'offer' && !isCaller) {
      gen = msg.data.gen;
      newPeer();
      pending = early.get(gen) ?? [];
      early.clear();
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.data.sdp });
      for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const a = await pc.createAnswer();
      await pc.setLocalDescription(a);
      signal('answer', { gen, sdp: pc.localDescription.sdp, type: pc.localDescription.type });
    } else if (msg.type === 'answer' && isCaller && pc) {
      if (msg.data?.gen === gen && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.data.sdp });
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      }
    } else if (msg.type === 'ice' && msg.data?.c) {
      if (msg.data.gen > gen && !isCaller) { early.set(msg.data.gen, [...(early.get(msg.data.gen) ?? []), msg.data.c]); return; }
      if (msg.data.gen !== gen) return;
      if (pc?.remoteDescription) await pc.addIceCandidate(msg.data.c).catch(() => {});
      else pending.push(msg.data.c);
    } else if (msg.type === 'bye') {
      onState('طرف مقابل تماس را ترک کرد', 'left');
      if (pc) { pc.close(); pc = null; }
      els.remote.srcObject = null;
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const r = await api('GET', `/v1/consultations/${cid}/signal?after=${lastSeq}`);
        if (lastSeq < 0) lastSeq = r.seq;
        for (const m of r.items) { lastSeq = Math.max(lastSeq, m.seq); await handle(m); }
        if (r.ended) { hangup(); return; }
      } catch { /* transient network error: keep polling */ }
      await new Promise((res) => setTimeout(res, 700));
    }
  }

  async function begin() {
    try {
      local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: videoWanted ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 24 } } : false,
      });
    } catch (e) {
      onState(e?.name === 'NotAllowedError' ? 'اجازه دسترسی به دوربین/میکروفون داده نشد' : 'دوربین یا میکروفون در دسترس نیست', 'error');
      return false;
    }
    els.local.srcObject = local;
    await api('GET', `/v1/consultations/${cid}/signal?after=-1`).then((r) => { lastSeq = r.seq; }).catch(() => {});
    loop();
    await signal('ready');
    onState('منتظر ورود طرف مقابل…', 'waiting');
    return true;
  }

  function hangup() {
    if (stopped) return;
    stopped = true;
    signal('bye');
    if (pc) pc.close();
    local?.getTracks().forEach((t) => t.stop());
    els.local.srcObject = null;
    els.remote.srcObject = null;
    onState('تماس پایان یافت', 'ended');
  }

  const toggle = (kind) => {
    const tracks = kind === 'audio' ? local?.getAudioTracks() : local?.getVideoTracks();
    if (!tracks?.length) return null;
    const on = !tracks[0].enabled;
    tracks.forEach((t) => { t.enabled = on; });
    return on;
  };

  return { begin, hangup, toggleMic: () => toggle('audio'), toggleCam: () => toggle('video') };
}
