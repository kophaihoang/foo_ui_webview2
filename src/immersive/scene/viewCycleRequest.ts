/**
 * A cover asks for the next immersive view (the one-tap view cycle) without knowing how views switch: the
 * page registers the handler while it is up. Scene elements may only reach the shared directories, so the
 * request goes through here.
 */
let handler: (() => void) | null = null;

/** Called by the page; returns the unregister */
export function handleViewCycle(next: () => void): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Move on to the next view, if a page is listening */
export function requestViewCycle(): void {
  handler?.();
}
