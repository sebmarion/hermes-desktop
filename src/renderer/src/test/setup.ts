import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Node 25 exposes a process-level `localStorage` getter even when no
// `--localstorage-file` was configured. Vitest copies that broken object onto
// the jsdom window, so install deterministic Storage semantics for tests.
const localStorageValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return localStorageValues.size;
  },
  clear() {
    localStorageValues.clear();
  },
  getItem(key) {
    return localStorageValues.get(String(key)) ?? null;
  },
  key(index) {
    return Array.from(localStorageValues.keys())[index] ?? null;
  },
  removeItem(key) {
    localStorageValues.delete(String(key));
  },
  setItem(key, value) {
    localStorageValues.set(String(key), String(value));
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  enumerable: true,
  value: testLocalStorage,
});
if (typeof window !== "undefined" && window !== globalThis) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    enumerable: true,
    value: testLocalStorage,
  });
}

// Mock react-loader-spinner which fails to load in test environment
vi.mock("react-loader-spinner", () => ({
  Grid: () => null,
  Audio: () => null,
  BallTriangle: () => null,
  Bars: () => null,
  Circles: () => null,
  CirclesWithBar: () => null,
  ColorRing: () => null,
  Comment: () => null,
  Discuss: () => null,
  DNA: () => null,
  FallingLines: () => null,
  FidgetSpinner: () => null,
  Hearts: () => null,
  InfinitySpin: () => null,
  LineWave: () => null,
  MagnifyingGlass: () => null,
  MutatingDots: () => null,
  Oval: () => null,
  ProgressBar: () => null,
  Puff: () => null,
  Radio: () => null,
  RevolvingDot: () => null,
  Rings: () => null,
  RotatingLines: () => null,
  RotatingSquare: () => null,
  RotatingTriangles: () => null,
  TailSpin: () => null,
  ThreeCircles: () => null,
  ThreeDots: () => null,
  Triangle: () => null,
  Vortex: () => null,
  Watch: () => null,
}));

afterEach(() => {
  cleanup();
});
