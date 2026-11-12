"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const read = () => (/Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl+");

/** Shortcut-hint prefix: "⌘" on Apple devices, "Ctrl+" elsewhere (the handlers accept both). */
export const useModKey = () => useSyncExternalStore(subscribe, read, () => "⌘");
