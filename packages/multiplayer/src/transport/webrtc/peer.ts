import type { ChannelOptions } from "../../types";
import type { PeerState } from "../types";

export interface PeerConnectionEvents {
  onStateChange: (state: PeerState) => void;
  onDataChannel: (channel: RTCDataChannel) => void;
  onIceCandidate: (candidate: RTCIceCandidate) => void;
}

/**
 * Manages a single RTCPeerConnection to one remote peer.
 *
 * ICE candidates that arrive before the remote description is set are
 * buffered and flushed automatically once setRemoteDescription completes.
 * This is critical for Firebase/MQTT signaling where offer, answer, and
 * candidates can arrive nearly simultaneously.
 */
export class PeerConnection {
  readonly peerId: string;
  private _connection: RTCPeerConnection;
  private _channels = new Map<string, RTCDataChannel>();
  private _events: PeerConnectionEvents;
  private _state: PeerState = 'connecting';
  private _remoteDescriptionSet = false;
  private _pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    peerId: string,
    config: RTCConfiguration,
    events: PeerConnectionEvents,
  ) {
    this.peerId = peerId;
    this._events = events;
    this._connection = new RTCPeerConnection(config);

    this._connection.onicecandidate = (e) => {
      if (e.candidate) {
        this._events.onIceCandidate(e.candidate);
      }
    };

    this._connection.oniceconnectionstatechange = () => {
      this._updateState();
    };

    this._connection.onconnectionstatechange = () => {
      this._updateState();
    };

    this._connection.ondatachannel = (e) => {
      const channel = e.channel;
      this._channels.set(channel.label, channel);
      this._events.onDataChannel(channel);
    };
  }

  get state(): PeerState {
    return this._state;
  }

  get connection(): RTCPeerConnection {
    return this._connection;
  }

  private _updateState(): void {
    const iceState = this._connection.iceConnectionState;
    const connState = this._connection.connectionState;

    let newState: PeerState;
    if (connState === 'connected' || iceState === 'connected') {
      newState = 'connected';
    } else if (connState === 'failed' || iceState === 'failed') {
      newState = 'failed';
    } else if (connState === 'closed' || iceState === 'closed' || iceState === 'disconnected') {
      newState = 'disconnected';
    } else {
      newState = 'connecting';
    }

    if (newState !== this._state) {
      this._state = newState;
      this._events.onStateChange(newState);
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this._connection.createOffer();
    await this._connection.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this._connection.setRemoteDescription(new RTCSessionDescription(offer));
    this._remoteDescriptionSet = true;
    await this._flushPendingCandidates();
    const answer = await this._connection.createAnswer();
    await this._connection.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this._connection.setRemoteDescription(new RTCSessionDescription(answer));
    this._remoteDescriptionSet = true;
    await this._flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this._remoteDescriptionSet) {
      // Buffer until remote description is set -- prevents silent drops
      this._pendingCandidates.push(candidate);
      return;
    }
    try {
      await this._connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Ignore ICE candidate errors (can happen during race conditions)
    }
  }

  private async _flushPendingCandidates(): Promise<void> {
    const candidates = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const c of candidates) {
      try {
        await this._connection.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // Ignore errors on individual candidates
      }
    }
  }

  createDataChannel(name: string, options?: ChannelOptions): RTCDataChannel {
    // If a channel with this label already exists (e.g. received via
    // ondatachannel from the remote peer), reuse it instead of creating
    // a duplicate that fragments send/receive across two channels.
    const existing = this._channels.get(name);
    if (existing && existing.readyState !== 'closed') {
      return existing;
    }

    const dcOptions: RTCDataChannelInit = {};
    if (options?.reliable === false) {
      dcOptions.ordered = options?.ordered ?? false;
      dcOptions.maxRetransmits = options?.maxRetransmits ?? 0;
    } else {
      dcOptions.ordered = options?.ordered ?? true;
    }
    const channel = this._connection.createDataChannel(name, dcOptions);
    this._channels.set(name, channel);
    return channel;
  }

  getDataChannel(name: string): RTCDataChannel | undefined {
    return this._channels.get(name);
  }

  close(): void {
    for (const channel of this._channels.values()) {
      try { channel.close(); } catch { /* ignore */ }
    }
    this._channels.clear();
    this._pendingCandidates = [];
    this._remoteDescriptionSet = false;
    try { this._connection.close(); } catch { /* ignore */ }
    this._state = 'disconnected';
  }
}
