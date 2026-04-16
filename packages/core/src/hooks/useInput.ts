import { useRef, useEffect, useCallback, useMemo } from "react";
import { getInputManager } from "../systems/InputManager";
import type { UseInputOptions, UseInputReturn, ActionMap } from "../types";

export function useInput(options: UseInputOptions = {}): UseInputReturn {
  const { actions = {}, enabled = true } = options;

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const actionsRef = useRef<ActionMap>(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const isPressed = useCallback((code: string) => {
    if (!enabledRef.current) return false;
    return getInputManager().getKey(code).pressed;
  }, []);

  const isJustPressed = useCallback((code: string) => {
    if (!enabledRef.current) return false;
    return getInputManager().getKey(code).justPressed;
  }, []);

  const isJustReleased = useCallback((code: string) => {
    if (!enabledRef.current) return false;
    return getInputManager().getKey(code).justReleased;
  }, []);

  const isAction = useCallback((action: string) => {
    if (!enabledRef.current) return false;
    const bindings = actionsRef.current[action];
    if (!bindings) return false;
    const mgr = getInputManager();
    return bindings.some((code) => mgr.getKey(code).pressed);
  }, []);

  const isActionJustPressed = useCallback((action: string) => {
    if (!enabledRef.current) return false;
    const bindings = actionsRef.current[action];
    if (!bindings) return false;
    const mgr = getInputManager();
    return bindings.some((code) => mgr.getKey(code).justPressed);
  }, []);

  const getAxis = useCallback((negative: string, positive: string) => {
    if (!enabledRef.current) return 0;
    const mgr = getInputManager();
    let value = 0;
    if (mgr.getKey(negative).pressed) value -= 1;
    if (mgr.getKey(positive).pressed) value += 1;
    return value;
  }, []);

  // Live reference to pointer state — always current when read inside useGameLoop
  const pointer = useMemo(() => getInputManager().getPointer(), []);

  return {
    isPressed,
    isJustPressed,
    isJustReleased,
    isAction,
    isActionJustPressed,
    pointer,
    getAxis,
  };
}
