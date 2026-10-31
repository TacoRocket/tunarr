# Request report ownership

Per-request MPEG-TS and HLS Direct v1 reporting uses request-scoped ownership:
`Session` holds a map keyed by server-generated request UUID. `SessionManager`
attaches internal requests to the exact concat session instance or places
standalone requests in a `RequestSession` in its existing session map.
Report-only sessions are excluded from playback and on-demand lookups.

`StreamRequestReport.ts` observes `ProgramStream` transcode assignments and
termination. It never starts or stops playback. Each request retains only its
current reasons; unknown and ended transcodes omit reasons. HTTP completion,
disconnect, failed startup, or explicit stop releases the request and listeners.
Parent stop clears its reports and late updates cannot repopulate them. State
is bounded by active requests, with no completed-request history or database.

Session IDs and request IDs correlate reports; they are not viewer identities.
Overlapping requests remain separate, including viewers behind the same IP.
See [the API semantics](../../../docs/fork/transcoding.md#live-fallback-reports).
