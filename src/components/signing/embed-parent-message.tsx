"use client";

import { useEffect } from "react";

// Tells the page that frames an embedded signing page what happened, once.
// Only ever to the origin the link was made for, which the server checked
// against the install's allowed sites, so nothing goes to a stranger.

export type EmbedMessage = {
  envelopeId?: string;
  signerId?: string;
  state?: string;
  type: "signudoc:declined" | "signudoc:error" | "signudoc:signed";
};

export function postToEmbedParent(origin: string, message: EmbedMessage) {
  if (window.parent !== window) {
    window.parent.postMessage(message, origin);
  }
}

export function EmbedParentMessage({
  message,
  origin,
}: {
  message: EmbedMessage;
  origin: string;
}) {
  const { envelopeId, signerId, state, type } = message;

  useEffect(() => {
    postToEmbedParent(origin, { envelopeId, signerId, state, type });
  }, [envelopeId, origin, signerId, state, type]);

  return null;
}
