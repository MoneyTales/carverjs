/**
 * Internal music engine handling crossfade between tracks.
 * Used exclusively by AudioManager — not exported publicly.
 */
export class MusicEngine {
  private _ctx: AudioContext;
  private _output: GainNode;

  private _source: AudioBufferSourceNode | null = null;
  private _gain: GainNode | null = null;
  private _buffer: AudioBuffer | null = null;

  private _volume = 1;
  private _loop = true;
  private _playing = false;
  private _paused = false;
  private _startTime = 0;
  private _pauseOffset = 0;

  constructor(ctx: AudioContext, output: GainNode) {
    this._ctx = ctx;
    this._output = output;
  }

  /**
   * Play a music track with optional crossfade from the current track.
   * If a track is already playing, the old track fades out while the new one fades in.
   */
  play(
    buffer: AudioBuffer,
    volume: number,
    loop: boolean,
    crossfadeDuration: number,
  ): void {
    const now = this._ctx.currentTime;

    // Crossfade: fade out current track
    if (this._source && this._gain) {
      const oldGain = this._gain;
      const oldSource = this._source;

      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0, now + crossfadeDuration);

      // Clean up old track after fade completes
      setTimeout(() => {
        try { oldSource.stop(); } catch { /* already stopped */ }
        oldGain.disconnect();
      }, (crossfadeDuration + 0.1) * 1000);
    }

    // Store state
    this._buffer = buffer;
    this._volume = volume;
    this._loop = loop;

    // Create new audio graph
    const gain = this._ctx.createGain();
    const source = this._ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain);
    gain.connect(this._output);

    // Fade in if crossfading, otherwise set volume immediately
    if (this._playing) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + crossfadeDuration);
    } else {
      gain.gain.setValueAtTime(volume, now);
    }

    source.start(0);

    this._source = source;
    this._gain = gain;
    this._startTime = now;
    this._pauseOffset = 0;
    this._playing = true;
    this._paused = false;

    // Handle non-looping track end
    if (!loop) {
      source.addEventListener("ended", () => {
        if (this._source === source) {
          this._playing = false;
          this._source = null;
          this._gain = null;
        }
      });
    }
  }

  /** Stop the current music track with optional fade-out. */
  stop(fadeOut = 0): void {
    if (!this._source || !this._gain) return;

    const now = this._ctx.currentTime;

    if (fadeOut > 0) {
      this._gain.gain.setValueAtTime(this._gain.gain.value, now);
      this._gain.gain.linearRampToValueAtTime(0, now + fadeOut);

      const source = this._source;
      const gain = this._gain;
      setTimeout(() => {
        try { source.stop(); } catch { /* already stopped */ }
        gain.disconnect();
      }, (fadeOut + 0.1) * 1000);
    } else {
      try { this._source.stop(); } catch { /* already stopped */ }
      this._gain.disconnect();
    }

    this._source = null;
    this._gain = null;
    this._playing = false;
    this._paused = false;
  }

  /** Pause the current music track. Records position for resume. */
  pause(): void {
    if (!this._playing || this._paused || !this._source) return;

    this._pauseOffset += this._ctx.currentTime - this._startTime;
    this._paused = true;

    try { this._source.stop(); } catch { /* already stopped */ }
    this._source = null;
  }

  /** Resume from the paused position. */
  resume(): void {
    if (!this._paused || !this._buffer || !this._gain) return;

    const source = this._ctx.createBufferSource();
    source.buffer = this._buffer;
    source.loop = this._loop;
    source.connect(this._gain);

    // Cancel any in-progress automation, set to target volume
    this._gain.gain.cancelScheduledValues(this._ctx.currentTime);
    this._gain.gain.setValueAtTime(this._volume, this._ctx.currentTime);

    const offset = this._pauseOffset % this._buffer.duration;
    source.start(0, offset);

    this._source = source;
    this._startTime = this._ctx.currentTime;
    this._paused = false;

    if (!this._loop) {
      source.addEventListener("ended", () => {
        if (this._source === source) {
          this._playing = false;
          this._source = null;
          this._gain = null;
        }
      });
    }
  }

  isPlaying(): boolean {
    return this._playing && !this._paused;
  }

  destroy(): void {
    this.stop();
  }
}
