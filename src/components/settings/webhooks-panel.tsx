"use client";

import { useEffect, useState } from "react";

import type { WebhookEndpoint } from "@/lib/webhooks/endpoints";
import {
  webhookEventTypes,
  type WebhookEventType,
} from "@/lib/webhooks/events";
import type { WebhookDeliverySummary } from "@/lib/webhooks/log";

// Webhook endpoints: where the install tells other apps that an envelope
// changed. Administrators only. A signing secret is shown once, right after
// it is made, and never again.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const WEBHOOK_DOCS_URL =
  "https://github.com/NYLLON-SOFTWARE/SignuDoc/blob/main/docs/api.md#webhooks";

const EVENT_LABELS: Record<WebhookEventType, string> = {
  "envelope.completed": "Completed",
  "envelope.declined": "Declined",
  "envelope.expired": "Expired",
  "envelope.sent": "Sent",
  "envelope.voided": "Voided",
  "signer.signed": "Signer signed",
  "signer.viewed": "Signer opened it",
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function formatTime(seconds: number | null) {
  return seconds === null
    ? null
    : timeFormatter.format(new Date(seconds * 1000));
}

type ApiPayload = {
  delivery?: {
    lastError: string | null;
    lastStatusCode: number | null;
    status: string;
  };
  deliveries?: WebhookDeliverySummary[];
  endpoint?: WebhookEndpoint;
  endpoints?: WebhookEndpoint[];
  error?: string;
  secret?: string;
} | null;

async function call(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; payload: ApiPayload }> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });

  return {
    ok: response.ok,
    payload: (await response.json().catch(() => null)) as ApiPayload,
  };
}

function deliveryTone(status: WebhookDeliverySummary["status"]) {
  return status === "delivered"
    ? "pill-success"
    : status === "failed"
      ? "pill-danger"
      : "pill-warning";
}

/**
 * One endpoint's recent deliveries. `refreshKey` changes when the panel
 * changes an endpoint: the log reads itself again but stays mounted, so a
 * "Send again" under way and its error are not lost. While the endpoint is
 * off (`paused`) nothing is sent, so Send again waits for it to be on.
 */
function DeliveryLog({
  endpointId,
  paused,
  refreshKey,
}: {
  endpointId: string;
  paused: boolean;
  refreshKey: number;
}) {
  const [deliveries, setDeliveries] = useState<WebhookDeliverySummary[] | null>(
    null,
  );
  // A failed read of the log goes once the log is read; a failed "Send
  // again" stays until the next one or Refresh.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { ok, payload } = await call(
          `/api/admin/webhooks/${encodeURIComponent(endpointId)}/deliveries`,
        );

        if (!cancelled) {
          if (ok && payload?.deliveries) {
            setDeliveries(payload.deliveries);
            setLoadError(null);
          } else {
            setLoadError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          }
        }
      } catch {
        if (!cancelled) {
          setLoadError(GENERIC_ERROR_MESSAGE);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [endpointId, refreshKey, revision]);

  function refresh() {
    setActionError(null);
    setRevision((value) => value + 1);
  }

  async function resend(id: string) {
    setPendingId(id);
    setActionError(null);

    try {
      const { ok, payload } = await call(
        `/api/admin/webhooks/deliveries/${encodeURIComponent(id)}/resend`,
        { method: "POST" },
      );

      if (!ok) {
        setActionError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      // Give the send a moment before reading the log again.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setRevision((value) => value + 1);
    } catch {
      setActionError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingId(null);
    }
  }

  // Errors show above the log rather than in its place, and Refresh is
  // always there, so a failed refresh or "Send again" never hides what was
  // already listed, and an empty or failed log can be read again.
  return (
    <div className="grid gap-2">
      <div className="flex justify-end">
        <button className="btn-quiet" onClick={refresh} type="button">
          Refresh
        </button>
      </div>
      {paused ? (
        <p className="text-sm text-(--secondary)">
          This endpoint is off, so nothing is sent to it. Deliveries that are
          waiting go out once it is turned on.
        </p>
      ) : null}
      {actionError ? (
        <p className="notice notice-danger" role="alert">
          {actionError}
        </p>
      ) : null}
      {loadError ? (
        <p className="notice notice-danger" role="alert">
          {loadError}
        </p>
      ) : null}
      {deliveries === null ? (
        loadError ? null : (
          <p className="text-sm text-(--secondary)">Loading...</p>
        )
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-(--secondary)">Nothing sent yet.</p>
      ) : (
        <DeliveryList
          canResend={!paused}
          deliveries={deliveries}
          onResend={(id) => void resend(id)}
          pendingId={pendingId}
        />
      )}
    </div>
  );
}

function DeliveryList({
  canResend,
  deliveries,
  onResend,
  pendingId,
}: {
  canResend: boolean;
  deliveries: WebhookDeliverySummary[];
  onResend: (id: string) => void;
  pendingId: string | null;
}) {
  return (
    <ul aria-label="Recent deliveries" className="grid gap-2">
      {deliveries.map((delivery) => (
        <li
          className="grid gap-1 rounded-lg border border-(--border) px-3 py-2 text-sm"
          key={delivery.id}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-(--fg)">{delivery.eventType}</span>
            <span className={`pill ${deliveryTone(delivery.status)}`}>
              {delivery.status === "pending" && delivery.attempts > 0
                ? "Retrying"
                : delivery.status === "pending"
                  ? "Waiting"
                  : delivery.status === "delivered"
                    ? "Delivered"
                    : "Failed"}
            </span>
            <span className="text-(--secondary)">
              {formatTime(delivery.createdAt)}
              {delivery.attempts > 1
                ? `, ${String(delivery.attempts)} tries`
                : ""}
              {delivery.lastStatusCode !== null
                ? `, answered ${String(delivery.lastStatusCode)}`
                : ""}
            </span>
          </div>
          {delivery.status !== "delivered" && delivery.lastError ? (
            <p className="break-all text-(--secondary)">
              {delivery.lastError}
              {delivery.status === "pending" && delivery.nextAttemptAt
                ? ` Next try around ${formatTime(delivery.nextAttemptAt) ?? ""}.`
                : ""}
            </p>
          ) : null}
          {delivery.status !== "pending" &&
          delivery.eventType !== "webhook.test" ? (
            <div>
              <button
                className="btn-quiet"
                disabled={!canResend || pendingId !== null}
                onClick={() => onResend(delivery.id)}
                type="button"
              >
                {pendingId === delivery.id ? "Sending..." : "Send again"}
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function WebhooksPanel() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  // A failed read of the list, with its own Try again, kept apart from the
  // error of an action so neither hides the other.
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([
    ...webhookEventTypes,
  ]);
  const [isCreating, setIsCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<{
    secret: string;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // When the list was last read, for telling which endpoints are still in
  // a secret switch-over.
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { ok, payload } = await call("/api/admin/webhooks");

        if (cancelled) {
          return;
        }

        if (!ok || !payload?.endpoints) {
          setListError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setNow(Math.floor(Date.now() / 1000));
        setEndpoints(payload.endpoints);
        setListError(null);
      } catch {
        if (!cancelled) {
          setListError(GENERIC_ERROR_MESSAGE);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  // Wakes the panel when the earliest switch-over ends, so its New secret
  // button comes back without reloading the page.
  useEffect(() => {
    const ends = (endpoints ?? [])
      .map((endpoint) => endpoint.previousSecretExpiresAt)
      .filter((at): at is number => at !== null && at > now);

    if (ends.length === 0) {
      return;
    }

    const waitMs = (Math.min(...ends) - Math.floor(Date.now() / 1000)) * 1000;
    const timer = window.setTimeout(
      () => setNow(Math.floor(Date.now() / 1000)),
      // Past the end by a second, and never longer than a timer can wait.
      Math.min(Math.max(waitMs, 0) + 1000, 2_147_483_647),
    );

    return () => window.clearTimeout(timer);
  }, [endpoints, now]);

  function showSecret(secret: string, endpointUrl: string) {
    setNewSecret({ secret, url: endpointUrl });
    setCopied(false);
  }

  // A change shows at once from its own answer, then the list is read
  // again. So if that read fails, a removed endpoint is not left on screen
  // with buttons for a row that is gone.
  function putEndpoint(changed: WebhookEndpoint) {
    setEndpoints((current) =>
      current === null
        ? current
        : current.some((endpoint) => endpoint.id === changed.id)
          ? current.map((endpoint) =>
              endpoint.id === changed.id ? changed : endpoint,
            )
          : [...current, changed],
    );
  }

  function dropEndpoint(id: string) {
    setEndpoints((current) =>
      current === null
        ? current
        : current.filter((endpoint) => endpoint.id !== id),
    );
    setOpenLogId((current) => (current === id ? null : current));
  }

  async function createEndpoint() {
    // A secret on screen stays until Done, so it is never lost to a second
    // endpoint, made or not. Nor while a new secret is on its way: both
    // answers would be shown, and the first would be lost.
    if (newSecret || pendingId !== null) {
      return;
    }

    setIsCreating(true);
    setError(null);
    setNotice(null);

    try {
      const { ok, payload } = await call("/api/admin/webhooks", {
        body: JSON.stringify({ description, events, url }),
        method: "POST",
      });

      if (!ok || !payload?.secret || !payload.endpoint) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      showSecret(payload.secret, payload.endpoint.url);
      putEndpoint(payload.endpoint);
      setUrl("");
      setDescription("");
      setRevision((value) => value + 1);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsCreating(false);
    }
  }

  async function act(
    endpoint: WebhookEndpoint,
    action: "delete" | "disable" | "enable" | "rotate" | "test",
  ) {
    // The same for a new secret: it would take the place of one on screen,
    // or of a new endpoint's secret still on its way.
    if (action === "rotate" && (newSecret || isCreating)) {
      return;
    }

    setPendingId(endpoint.id);
    setError(null);
    setNotice(null);

    const base = `/api/admin/webhooks/${encodeURIComponent(endpoint.id)}`;

    try {
      const { ok, payload } =
        action === "delete"
          ? await call(base, { method: "DELETE" })
          : action === "rotate"
            ? await call(`${base}/rotate`, { method: "POST" })
            : action === "test"
              ? await call(`${base}/test`, { method: "POST" })
              : await call(base, {
                  body: JSON.stringify({ enabled: action === "enable" }),
                  method: "PATCH",
                });

      if (!ok) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      if (action === "rotate" && payload?.secret) {
        showSecret(payload.secret, endpoint.url);
      }

      if (action === "delete") {
        dropEndpoint(endpoint.id);
      } else if (payload?.endpoint) {
        putEndpoint(payload.endpoint);
      }

      if (action === "test" && payload?.delivery) {
        const { delivery } = payload;

        setNotice(
          delivery.status === "delivered"
            ? `The test event was delivered (answered ${String(delivery.lastStatusCode)}).`
            : `The test event was not delivered: ${delivery.lastError ?? "no answer"}.`,
        );
      }

      setRemovingId(null);
      setRevision((value) => value + 1);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingId(null);
    }
  }

  async function copySecret() {
    if (!newSecret) {
      return;
    }

    try {
      await navigator.clipboard.writeText(newSecret.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function toggleEvent(type: WebhookEventType) {
    setEvents((current) =>
      current.includes(type)
        ? current.filter((value) => value !== type)
        : webhookEventTypes.filter(
            (value) => value === type || current.includes(value),
          ),
    );
  }

  return (
    <div className="space-y-5 border-t border-(--border) pt-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Webhooks
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Tell another app when an envelope is sent, opened, signed, completed,
          declined, voided or expires. Each event is POSTed to the URL as JSON
          and signed with the endpoint&apos;s secret, the{" "}
          <a
            className="font-semibold text-(--accent) underline-offset-4 hover:underline"
            href={WEBHOOK_DOCS_URL}
            rel="noreferrer"
            target="_blank"
          >
            Standard Webhooks
          </a>{" "}
          way. Endpoints get events for every envelope on this install. If the
          app does not answer, the event is tried again for about two days.
        </p>
      </div>

      <div className="grid max-w-xl gap-4">
        <label className="grid gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            URL
          </span>
          <input
            autoComplete="off"
            className="field-input"
            disabled={isCreating}
            inputMode="url"
            maxLength={2048}
            name="webhook-url"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://app.example.com/webhooks/signudoc"
            value={url}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Description (optional)
          </span>
          <input
            autoComplete="off"
            className="field-input"
            disabled={isCreating}
            maxLength={200}
            name="webhook-description"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this endpoint is for"
            value={description}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-[0.8125rem] font-semibold text-(--secondary)">
            Events
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {webhookEventTypes.map((type) => (
              <label
                className="flex items-center gap-2 text-sm text-(--fg)"
                key={type}
              >
                <input
                  checked={events.includes(type)}
                  disabled={isCreating}
                  name={`webhook-event-${type}`}
                  onChange={() => toggleEvent(type)}
                  type="checkbox"
                />
                {EVENT_LABELS[type]}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <button
            className="btn-quiet min-h-12 px-5 text-sm"
            disabled={
              isCreating ||
              pendingId !== null ||
              newSecret !== null ||
              url.trim().length === 0 ||
              events.length === 0
            }
            onClick={() => void createEndpoint()}
            type="button"
          >
            {isCreating ? "Adding..." : "Add endpoint"}
          </button>
        </div>
      </div>

      {newSecret ? (
        <div
          className="well grid max-w-2xl gap-3 p-4"
          data-testid="new-webhook-secret"
          role="status"
        >
          <p className="text-sm font-semibold text-(--fg)">
            Copy the signing secret for {newSecret.url} now. It is not shown
            again. Press Done once it is copied, before adding another endpoint
            or making another secret.
          </p>
          <code className="block overflow-x-auto rounded-lg border border-(--border) bg-(--paper) px-3 py-2 font-mono text-sm break-all text-(--fg)">
            {newSecret.secret}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-quiet"
              onClick={() => void copySecret()}
              type="button"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="btn-quiet"
              onClick={() => setNewSecret(null)}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className="notice notice-accent max-w-2xl" role="status">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p className="notice notice-danger max-w-2xl" role="alert">
          {error}
        </p>
      ) : null}

      {listError ? (
        <div className="notice notice-danger grid max-w-2xl gap-2" role="alert">
          <p>{listError}</p>
          <div>
            <button
              className="btn-quiet"
              onClick={() => {
                setListError(null);
                setRevision((value) => value + 1);
              }}
              type="button"
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {endpoints === null ? null : endpoints.length === 0 ? (
        <p className="text-sm text-(--secondary)">No endpoints yet.</p>
      ) : (
        <ul aria-label="Webhook endpoints" className="grid max-w-2xl gap-3">
          {endpoints.map((endpoint) => (
            <li className="well grid gap-2 p-4" key={endpoint.id}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-sm font-bold break-all text-(--fg)">
                  {endpoint.url}
                </p>
                <span
                  className={`pill ${endpoint.enabled ? "pill-success" : "pill-neutral"}`}
                >
                  {endpoint.enabled ? "On" : "Off"}
                </span>
              </div>
              {endpoint.description ? (
                <p className="text-sm text-(--secondary)">
                  {endpoint.description}
                </p>
              ) : null}
              <p className="text-sm text-(--secondary)">
                {endpoint.events.length === webhookEventTypes.length
                  ? "All events."
                  : `${endpoint.events.map((type) => EVENT_LABELS[type]).join(", ")}.`}
                {endpoint.previousSecretExpiresAt &&
                endpoint.previousSecretExpiresAt > now
                  ? ` The old secret also signs until ${formatTime(endpoint.previousSecretExpiresAt) ?? ""}, and another new secret can be made after that.`
                  : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {removingId === endpoint.id ? (
                  <>
                    <span className="text-sm text-(--secondary)">
                      Remove this endpoint and its delivery log?
                    </span>
                    <button
                      className="btn-quiet btn-quiet-danger"
                      disabled={pendingId !== null}
                      onClick={() => void act(endpoint, "delete")}
                      type="button"
                    >
                      {pendingId === endpoint.id ? "Removing..." : "Remove"}
                    </button>
                    <button
                      className="btn-quiet"
                      disabled={pendingId !== null}
                      onClick={() => setRemovingId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn-quiet"
                      disabled={pendingId !== null || !endpoint.enabled}
                      onClick={() => void act(endpoint, "test")}
                      type="button"
                    >
                      {pendingId === endpoint.id ? "Working..." : "Send test"}
                    </button>
                    <button
                      className="btn-quiet"
                      disabled={pendingId !== null}
                      onClick={() =>
                        void act(
                          endpoint,
                          endpoint.enabled ? "disable" : "enable",
                        )
                      }
                      type="button"
                    >
                      {endpoint.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      className="btn-quiet"
                      disabled={
                        pendingId !== null ||
                        isCreating ||
                        newSecret !== null ||
                        (endpoint.previousSecretExpiresAt !== null &&
                          endpoint.previousSecretExpiresAt > now)
                      }
                      onClick={() => void act(endpoint, "rotate")}
                      type="button"
                    >
                      New secret
                    </button>
                    <button
                      aria-expanded={openLogId === endpoint.id}
                      className="btn-quiet"
                      onClick={() =>
                        setOpenLogId((current) =>
                          current === endpoint.id ? null : endpoint.id,
                        )
                      }
                      type="button"
                    >
                      {openLogId === endpoint.id ? "Hide log" : "Delivery log"}
                    </button>
                    <button
                      aria-label={`Remove ${endpoint.url}`}
                      className="btn-quiet btn-quiet-danger"
                      disabled={pendingId !== null}
                      onClick={() => setRemovingId(endpoint.id)}
                      type="button"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {openLogId === endpoint.id ? (
                <DeliveryLog
                  endpointId={endpoint.id}
                  paused={!endpoint.enabled}
                  refreshKey={revision}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
