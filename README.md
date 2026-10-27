# JC WhatsApp MI — Log → cURL

Paste raw WSO2 / Synapse log-mediator output from the JazzCash WhatsApp MI, get ready-to-run `curl` commands for the successful downstream calls (with the logged response shown for comparison).

**Live:** https://haziqbaig.github.io/jc-log2curl/

- 100% client-side — logs never leave the browser.
- Also parses inbound `EVENT_LOG_REQUEST` / `EVENT_LOG_RESPONSE` entries (paired by `CORRELATION_ID`); set the MI endpoint once in the UI since the log omits the URL.
- Parses `HeaderToken`, `REQUEST_URL`, `REQUEST_METHOD`, `REQUEST_BODY` (multi-line OK), `RESPONSE_BODY`.
- Pairs each RESPONSE with its REQUEST and judges success (Infobip status groups, `requestError`, HTTP codes).
- Options: success-only filter, token masking, copy / download as `replay.sh`.

Local CLI equivalent: `node ../tools/log2curl.mjs <logfile>`.
