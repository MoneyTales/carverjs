import type { KeyState, PointerState } from "../types";

const DEFAULT_KEY_STATE: KeyState = {
  pressed: false,
  justPressed: false,
  justReleased: false,
};

class InputManager {
  private _keys: Map<string, KeyState> = new Map();
  private _pendingDown: Set<string> = new Set();
  private _pendingUp: Set<string> = new Set();
  private _pointer: PointerState = {
    position: { x: 0, y: 0 },
    isDown: false,
    justDown: false,
    justUp: false,
  };
  private _pendingPointerDown = false;
  private _pendingPointerUp = false;
  private _attached = false;

  // Bound handlers stored as arrow-function properties for clean removal
  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this._pendingDown.add(e.code);
    this._pendingUp.delete(e.code);
  };

  private _onKeyUp = (e: KeyboardEvent) => {
    this._pendingUp.add(e.code);
    this._pendingDown.delete(e.code);
  };

  private _onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this._pendingPointerDown = true;
    this._pendingPointerUp = false;
    this._pointer.position.x = e.clientX;
    this._pointer.position.y = e.clientY;
  };

  private _onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this._pendingPointerUp = true;
    this._pendingPointerDown = false;
    this._pointer.position.x = e.clientX;
    this._pointer.position.y = e.clientY;
  };

  private _onPointerMove = (e: PointerEvent) => {
    this._pointer.position.x = e.clientX;
    this._pointer.position.y = e.clientY;
  };

  private _onTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    this._pendingPointerDown = true;
    this._pendingPointerUp = false;
    this._pointer.position.x = touch.clientX;
    this._pointer.position.y = touch.clientY;
  };

  private _onTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    this._pointer.position.x = touch.clientX;
    this._pointer.position.y = touch.clientY;
  };

  private _onTouchEnd = () => {
    this._pendingPointerUp = true;
    this._pendingPointerDown = false;
  };

  private _onBlur = () => {
    for (const [code, state] of this._keys) {
      if (state.pressed) {
        this._pendingUp.add(code);
      }
    }
    this._pendingDown.clear();

    if (this._pointer.isDown) {
      this._pendingPointerUp = true;
      this._pendingPointerDown = false;
    }
  };

  /** Attach DOM listeners. Keyboard + blur on window, pointer/touch on target element. */
  attach(target: HTMLElement): void {
    if (this._attached) return;
    this._attached = true;

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);

    target.addEventListener("pointerdown", this._onPointerDown);
    target.addEventListener("pointerup", this._onPointerUp);
    target.addEventListener("pointermove", this._onPointerMove);
    target.addEventListener("touchstart", this._onTouchStart, { passive: true });
    target.addEventListener("touchmove", this._onTouchMove, { passive: true });
    target.addEventListener("touchend", this._onTouchEnd, { passive: true });
    target.addEventListener("touchcancel", this._onTouchEnd, { passive: true });
  }

  /** Remove all DOM listeners */
  detach(): void {
    if (!this._attached) return;
    this._attached = false;

    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
  }

  /**
   * Called once per frame at priority -50, BEFORE all game logic stages.
   * Clears previous frame's transient state, then applies queued DOM events.
   */
  flush(): void {
    // 1. Clear previous frame's justPressed / justReleased
    for (const [, state] of this._keys) {
      state.justPressed = false;
      state.justReleased = false;
    }

    // 2. Apply pending key presses
    for (const code of this._pendingDown) {
      let state = this._keys.get(code);
      if (!state) {
        state = { pressed: false, justPressed: false, justReleased: false };
        this._keys.set(code, state);
      }
      state.pressed = true;
      state.justPressed = true;
    }
    this._pendingDown.clear();

    // 3. Apply pending key releases
    for (const code of this._pendingUp) {
      let state = this._keys.get(code);
      if (!state) {
        state = { pressed: false, justPressed: false, justReleased: false };
        this._keys.set(code, state);
      }
      state.pressed = false;
      state.justReleased = true;
    }
    this._pendingUp.clear();

    // 4. Pointer transient state
    this._pointer.justDown = false;
    this._pointer.justUp = false;

    if (this._pendingPointerDown) {
      this._pointer.isDown = true;
      this._pointer.justDown = true;
      this._pendingPointerDown = false;
    }
    if (this._pendingPointerUp) {
      this._pointer.isDown = false;
      this._pointer.justUp = true;
      this._pendingPointerUp = false;
    }
  }

  // ── Query API ──

  /** Get the state of a key by its KeyboardEvent.code. Returns default (all false) if never seen. */
  getKey(code: string): Readonly<KeyState> {
    return this._keys.get(code) ?? DEFAULT_KEY_STATE;
  }

  /** Get the current pointer state. Returns a live reference — always up to date. */
  getPointer(): PointerState {
    return this._pointer;
  }
}

// ── Singleton accessor ──

let _instance: InputManager | null = null;

export function getInputManager(): InputManager {
  if (!_instance) _instance = new InputManager();
  return _instance;
}

export function destroyInputManager(): void {
  _instance?.detach();
  _instance = null;
}
