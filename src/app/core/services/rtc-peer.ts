/**
 * PeerLink — wraps a single RTCPeerConnection plus the per-connection state the
 * "perfect negotiation" pattern needs (see MDN: Perfect negotiation).
 *
 * One PeerLink represents one leg of the voice mesh:
 *   • On a MEMBER there is exactly one PeerLink — to the leader (polite=true).
 *   • On the LEADER there is one PeerLink per member (polite=false / impolite).
 *
 * The leader, acting as an SFU, forwards every member's inbound audio track onto
 * every OTHER member's PeerLink. `forwardedSenders` tracks which RTCRtpSender on
 * THIS connection carries which other peer's track, so the track can be removed
 * cleanly when that other peer leaves.
 */
export class PeerLink {
  readonly addr:  string;            // TCP signalling address that identifies the remote peer
  readonly pc:    RTCPeerConnection;
  readonly polite: boolean;          // perfect-negotiation role (member = polite)
  name: string;                      // display name, for UI

  // ── Perfect-negotiation state ──────────────────────────────────────────
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;

  // ── SFU bookkeeping ────────────────────────────────────────────────────
  /** This peer's own inbound mic track/stream (set on first `ontrack`). */
  inboundTrack:  MediaStreamTrack | null = null;
  inboundStream: MediaStream      | null = null;
  /** other-peer-addr → the RTCRtpSender on THIS pc that forwards their track. */
  readonly forwardedSenders = new Map<string, RTCRtpSender>();

  /** Coalesces a burst of addTrack()/removeTrack() into a single offer. */
  negotiateScheduled = false;

  constructor(addr: string, name: string, pc: RTCPeerConnection, polite: boolean) {
    this.addr   = addr;
    this.name   = name;
    this.pc     = pc;
    this.polite = polite;
  }

  close(): void {
    this.forwardedSenders.clear();
    this.inboundTrack  = null;
    this.inboundStream = null;
    try { this.pc.close(); } catch { /* already closed */ }
  }
}
