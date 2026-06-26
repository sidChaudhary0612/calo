import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { DataBusService } from './data-bus.service';
import { PeerLink } from './rtc-peer';

/**
 * RtcVoiceService — full-duplex group voice over WebRTC.
 *
 * Topology (see plan): the group leader is an SFU. Each member holds ONE
 * RTCPeerConnection to the leader; the leader holds one per member and forwards
 * every member's inbound audio track onto every other member's connection.
 *
 * Signalling (SDP + ICE) rides the existing TCP P2pSocket via DataBus on the
 * 'rtc-signal' channel. Audio RTP flows directly over the Wi-Fi Direct LAN
 * (host ICE candidates only — iceServers is empty, no STUN/TURN).
 *
 * Routing rule:
 *   member → leader : bus.send('rtc-signal', msg)            (no target)
 *   leader → member : bus.send('rtc-signal', msg, addr)      (targeted)
 * The leader maps an incoming signal to the correct PeerLink by the
 * `peerAddress` the bus reports — never by anything in the payload.
 */

type Role = 'leader' | 'member';

type RtcSignal =
  | { t: 'offer';  sdp: string; from: string }
  | { t: 'answer'; sdp: string; from: string }
  | { t: 'ice';    candidate: RTCIceCandidateInit | null; from: string }
  | { t: 'bye';    from: string };

const CHANNEL = 'rtc-signal';
const MAX_PEERS = 6;                 // hard cap — leader forwarding cost grows with N
const SPEAKING_THRESHOLD = 0.04;     // RMS above which a stream counts as "active"

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
    channelCount:     1,
  },
  video: false,
};

const PC_CONFIG: RTCConfiguration = {
  iceServers:           [],            // LAN only — host candidates are directly routable
  iceCandidatePoolSize: 0,
  bundlePolicy:         'max-bundle',
};

interface Playback {
  el:       HTMLAudioElement;
  source:   MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf:      Float32Array;
}

@Injectable({ providedIn: 'root' })
export class RtcVoiceService implements OnDestroy {
  private _bus = inject(DataBusService);

  // ── Public reactive state ───────────────────────────────────────────────
  readonly live          = signal(false);
  readonly muted         = signal(false);
  readonly volume        = signal(80);
  readonly peerCount     = signal(0);
  /** trackId → instantaneous RMS level 0..1, for per-speaker meters. */
  readonly speakerLevels = signal<Map<string, number>>(new Map());

  readonly supported =
    typeof RTCPeerConnection !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  // ── Private state ───────────────────────────────────────────────────────
  private _role: Role | null = null;
  private _links = new Map<string, PeerLink>();       // remote addr → link
  private _known = new Map<string, string>();         // addr → name (TCP-connected peers)

  private _micStream: MediaStream      | null = null;
  private _micTrack:  MediaStreamTrack | null = null;

  private _audioCtx:   AudioContext | null = null;
  private _masterGain: GainNode     | null = null;
  private _playbacks = new Map<string, Playback>();   // trackId → playback graph

  private _meterRaf: ReturnType<typeof setInterval> | null = null;
  private _busTeardown: (() => void) | null = null;

  constructor() {
    this._busTeardown = this._bus.register(CHANNEL, (payload, addr) => {
      try { this._onSignal(addr, JSON.parse(atob(payload)) as RtcSignal); }
      catch { /* malformed signal */ }
    });
  }

  // ─── Lifecycle hooks called by MeshService ───────────────────────────────

  /** Leader: a member's TCP socket connected. */
  onMemberConnected(addr: string, name: string): void {
    this._role = 'leader';
    this._known.set(addr, name);
    if (this.live()) this._createLink(addr, name, /*polite*/ false);
  }

  /** Member: our TCP socket to the leader connected. */
  onConnectedToLeader(addr: string, name = 'Leader'): void {
    this._role = 'member';
    this._known.set(addr, name);
    if (this.live()) this._createLink(addr, name, /*polite*/ true);
  }

  /** Either role: a peer's TCP socket dropped. */
  onPeerDisconnected(addr: string): void {
    this._known.delete(addr);
    const link = this._links.get(addr);
    if (!link) return;

    // Leader: pull this peer's forwarded track off every other member's PC.
    if (this._role === 'leader') {
      for (const other of this._links.values()) {
        if (other === link) continue;
        const sender = other.forwardedSenders.get(addr);
        if (sender) {
          try { other.pc.removeTrack(sender); } catch { /* closing */ }
          other.forwardedSenders.delete(addr);
        }
      }
    }

    if (link.inboundTrack) this._teardownPlayback(link.inboundTrack.id);
    link.close();
    this._links.delete(addr);
    this.peerCount.set(this._links.size);
  }

  // ─── Go live / leave ─────────────────────────────────────────────────────

  async goLive(): Promise<boolean> {
    if (this.live()) return true;
    if (!this.supported) return false;

    try {
      this._micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch {
      return false;   // mic denied (check WebView onPermissionRequest grant)
    }
    this._micTrack = this._micStream.getAudioTracks()[0] ?? null;
    if (this._micTrack) this._micTrack.enabled = !this.muted();

    this._ensureAudioContext();
    this.live.set(true);

    // Spin up a connection for every already-known peer.
    const polite = this._role === 'member';
    for (const [addr, name] of this._known) {
      if (!this._links.has(addr)) this._createLink(addr, name, polite);
    }

    this._startMeterLoop();
    return true;
  }

  leaveVoice(): void {
    for (const link of this._links.values()) link.close();
    this._links.clear();
    this.peerCount.set(0);

    for (const id of [...this._playbacks.keys()]) this._teardownPlayback(id);
    this.speakerLevels.set(new Map());

    this._micTrack?.stop();
    this._micStream?.getTracks().forEach(t => t.stop());
    this._micTrack = null;
    this._micStream = null;

    if (this._meterRaf) { clearInterval(this._meterRaf); this._meterRaf = null; }
    this.live.set(false);
  }

  // ─── Controls ────────────────────────────────────────────────────────────

  toggleMute(): void {
    const m = !this.muted();
    this.muted.set(m);
    if (this._micTrack) this._micTrack.enabled = !m;   // no renegotiation
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(100, v));
    this.volume.set(clamped);
    if (this._masterGain) this._masterGain.gain.value = clamped / 100;
  }

  // ─── Connection setup ────────────────────────────────────────────────────

  private _createLink(addr: string, name: string, polite: boolean): void {
    if (this._links.has(addr)) return;
    if (this._links.size >= MAX_PEERS) return;

    const pc = new RTCPeerConnection(PC_CONFIG);
    const link = new PeerLink(addr, name, pc, polite);
    this._links.set(addr, link);
    this.peerCount.set(this._links.size);

    // Send our mic to this peer.
    if (this._micTrack && this._micStream) {
      pc.addTrack(this._micTrack, this._micStream);
    }

    // Leader only: forward every already-known inbound track to the newcomer.
    if (this._role === 'leader') {
      for (const other of this._links.values()) {
        if (other === link || !other.inboundTrack || !other.inboundStream) continue;
        const sender = pc.addTrack(other.inboundTrack, other.inboundStream);
        link.forwardedSenders.set(other.addr, sender);
      }
    }

    this._wireNegotiation(link);
  }

  private _wireNegotiation(link: PeerLink): void {
    const pc = link.pc;

    pc.onnegotiationneeded = () => this._scheduleOffer(link);

    pc.onicecandidate = ({ candidate }) =>
      this._send(link, { t: 'ice', candidate: candidate ?? null, from: this._selfTag() });

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch { /* not supported */ }
      }
    };

    pc.ontrack = (ev) => this._onRemoteTrack(link, ev);
  }

  /** Coalesce a burst of addTrack/removeTrack into a single offer per tick. */
  private _scheduleOffer(link: PeerLink): void {
    if (link.negotiateScheduled) return;
    link.negotiateScheduled = true;
    queueMicrotask(async () => {
      link.negotiateScheduled = false;
      try {
        link.makingOffer = true;
        await link.pc.setLocalDescription();
        const desc = link.pc.localDescription;
        if (desc) this._send(link, { t: 'offer', sdp: desc.sdp, from: this._selfTag() });
      } catch { /* offer aborted */ }
      finally { link.makingOffer = false; }
    });
  }

  // ─── Signalling (perfect negotiation) ────────────────────────────────────

  private async _onSignal(addr: string, msg: RtcSignal): Promise<void> {
    const link = this._links.get(addr);
    if (!link) return;                     // signal before the PC exists — ignore
    const pc = link.pc;

    try {
      if (msg.t === 'offer' || msg.t === 'answer') {
        const ready =
          !link.makingOffer &&
          (pc.signalingState === 'stable' || link.isSettingRemoteAnswerPending);
        const offerCollision = msg.t === 'offer' && !ready;

        link.ignoreOffer = !link.polite && offerCollision;
        if (link.ignoreOffer) return;       // impolite side wins the glare

        link.isSettingRemoteAnswerPending = msg.t === 'answer';
        await pc.setRemoteDescription({ type: msg.t, sdp: msg.sdp });
        link.isSettingRemoteAnswerPending = false;

        if (msg.t === 'offer') {
          await pc.setLocalDescription();
          const desc = pc.localDescription;
          if (desc) this._send(link, { t: 'answer', sdp: desc.sdp, from: this._selfTag() });
        }
      } else if (msg.t === 'ice') {
        try {
          await pc.addIceCandidate(this._sanitizeCandidate(msg.candidate, link.addr));
        } catch (e) {
          if (!link.ignoreOffer) throw e;   // expected after an ignored offer
        }
      } else if (msg.t === 'bye') {
        this.onPeerDisconnected(addr);
      }
    } catch { /* renegotiation hiccup — perfect negotiation recovers next round */ }
  }

  /**
   * Wi-Fi Direct LANs have no mDNS resolver, so Chromium's privacy-obfuscated
   * `*.local` host candidates would never resolve. We already know the remote's
   * real LAN IP (its signalling address), so rewrite the hostname to that IP.
   * A null candidate is end-of-candidates — pass through (undefined).
   */
  private _sanitizeCandidate(
    cand: RTCIceCandidateInit | null,
    remoteIp: string,
  ): RTCIceCandidateInit | undefined {
    if (!cand || !cand.candidate) return undefined;
    if (!/\.local(\s|$)/i.test(cand.candidate)) return cand;
    return { ...cand, candidate: cand.candidate.replace(/[^\s]+\.local/gi, remoteIp) };
  }

  // ─── SFU track forwarding ────────────────────────────────────────────────

  private _onRemoteTrack(link: PeerLink, ev: RTCTrackEvent): void {
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);

    // Members render every track they receive. The leader also hears members,
    // and additionally forwards each member's track to all other members.
    this._addPlayback(ev.track, stream);
    ev.track.addEventListener('ended', () => this._teardownPlayback(ev.track.id));

    if (this._role === 'leader') {
      link.inboundTrack  = ev.track;
      link.inboundStream = stream;
      for (const other of this._links.values()) {
        if (other === link || other.forwardedSenders.has(link.addr)) continue;
        const sender = other.pc.addTrack(ev.track, stream);   // → fires their onnegotiationneeded
        other.forwardedSenders.set(link.addr, sender);
      }
    }
  }

  // ─── Audio playback + metering ───────────────────────────────────────────

  private _ensureAudioContext(): void {
    if (this._audioCtx) return;
    this._audioCtx = new AudioContext();
    this._masterGain = this._audioCtx.createGain();
    this._masterGain.gain.value = this.volume() / 100;
    this._masterGain.connect(this._audioCtx.destination);
  }

  private _addPlayback(track: MediaStreamTrack, stream: MediaStream): void {
    if (this._playbacks.has(track.id)) return;
    this._ensureAudioContext();
    const ctx = this._audioCtx!;

    // Prime the WebRTC audio pipeline: Chromium will not pull a remote track
    // through Web Audio alone, so attach a muted <audio> element to drive it.
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    el.autoplay = true;
    el.play().catch(() => { /* will start on the next user gesture */ });

    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(this._masterGain!);

    this._playbacks.set(track.id, {
      el, source, analyser, buf: new Float32Array(analyser.fftSize),
    });
  }

  private _teardownPlayback(trackId: string): void {
    const pb = this._playbacks.get(trackId);
    if (!pb) return;
    try { pb.source.disconnect(); } catch { /* */ }
    try { pb.analyser.disconnect(); } catch { /* */ }
    pb.el.srcObject = null;
    this._playbacks.delete(trackId);
    this.speakerLevels.update(m => { const n = new Map(m); n.delete(trackId); return n; });
  }

  private _startMeterLoop(): void {
    if (this._meterRaf) return;
    this._meterRaf = setInterval(() => {
      if (this._playbacks.size === 0) return;
      const levels = new Map<string, number>();
      for (const [id, pb] of this._playbacks) {
        pb.analyser.getFloatTimeDomainData(pb.buf);
        let sum = 0;
        for (let i = 0; i < pb.buf.length; i++) sum += pb.buf[i] * pb.buf[i];
        const rms = Math.sqrt(sum / pb.buf.length);
        levels.set(id, rms >= SPEAKING_THRESHOLD ? Math.min(1, rms * 4) : 0);
      }
      this.speakerLevels.set(levels);
    }, 100);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private _send(link: PeerLink, msg: RtcSignal): void {
    // Member sends to its only socket (no target); leader targets the member.
    const target = this._role === 'leader' ? link.addr : undefined;
    this._bus.send(CHANNEL, msg, target);
  }

  private _selfTag(): string {
    return this._role === 'leader' ? 'leader' : 'member';
  }

  ngOnDestroy(): void {
    this.leaveVoice();
    this._busTeardown?.();
    this._audioCtx?.close().catch(() => {});
  }
}
