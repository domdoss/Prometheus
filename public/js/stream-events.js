// Mirror of src/shared/stream-events.ts. Update in lockstep.
//
// This module is loaded as a classic <script> tag BEFORE app.js so it can
// expose its surface on `window.WardenStreamEvents`. app.js is a classic
// (non-module) IIFE script — we can't use ES `import`/`export` here without
// breaking it. The shape mirrors the host TypeScript module's exports:
//
//   STREAM_SCHEMA_VERSION  : number
//   STREAM_EVENT_MARKER    : '---WARDEN_EVENT---'
//   decodeStreamEvent(line): StreamEvent | null
//
// The host TS file has a JSON-encoder (encodeStreamEvent) that the runtime
// imports; the browser doesn't need to encode, only decode.
(function () {
  var STREAM_SCHEMA_VERSION = 1;
  var STREAM_EVENT_MARKER = '---WARDEN_EVENT---';

  /**
   * Decode one buffer line into a StreamEvent if it carries the marker.
   * Returns null on non-event lines or parse errors. Never throws.
   */
  function decodeStreamEvent(line) {
    if (typeof line !== 'string') return null;
    if (!line || line.indexOf(STREAM_EVENT_MARKER) !== 0) return null;
    var body = line.slice(STREAM_EVENT_MARKER.length).trim();
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }

  // Expose under a single global namespace so app.js can pull from it without
  // module wiring. Test harness in src/stream-events-frontend.test.ts loads
  // this file via fs+vm to read the same surface.
  var api = {
    STREAM_SCHEMA_VERSION: STREAM_SCHEMA_VERSION,
    STREAM_EVENT_MARKER: STREAM_EVENT_MARKER,
    decodeStreamEvent: decodeStreamEvent,
  };

  if (typeof window !== 'undefined') {
    window.WardenStreamEvents = api;
  }
  // CommonJS-style export for the Node test harness. `module` is not defined
  // in browsers — guard before assignment so we don't trip ReferenceError.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
