import { useEffect, useRef } from "react";

export const SESSION_REVISION_POLL_MS = 5_000;
const SESSION_REVISION_FALLBACK_MS = 30_000;

export function useSessionRevisionPoll({
  profile,
  onChange,
}: {
  profile: string;
  onChange: () => void | Promise<void>;
}): void {
  const onChangeRef = useRef(onChange);
  const lastRevisionRef = useRef<string | null | undefined>(undefined);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const generation = ++generationRef.current;
    lastRevisionRef.current = undefined;
    let lastFallbackAt = Date.now();

    const maybeFallback = async (): Promise<void> => {
      const now = Date.now();
      if (now - lastFallbackAt < SESSION_REVISION_FALLBACK_MS) return;
      lastFallbackAt = now;
      await onChangeRef.current();
    };

    const poll = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const revision = await window.hermesAPI.getSessionRevision();
        if (generationRef.current !== generation) return;

        if (!revision) {
          lastRevisionRef.current = null;
          await maybeFallback();
          return;
        }

        const previous = lastRevisionRef.current;
        lastRevisionRef.current = revision;
        if (previous !== undefined && previous !== revision) {
          await onChangeRef.current();
        }
      } catch {
        // A transient failure must not clear the known revision. Older builds
        // without the IPC contract still converge through the bounded fallback.
        await maybeFallback();
      } finally {
        inFlightRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(
      () => void poll(),
      SESSION_REVISION_POLL_MS,
    );
    const resume = (): void => {
      void poll();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [profile]);
}
