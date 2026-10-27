# JC WhatsApp MI — Log → cURL

**Live:** https://haziqbaig.github.io/jc-log2curl/

Drop a WSO2 Micro Integrator log file (or paste lines) from the JazzCash WhatsApp MI and get, for every API call:

- a plain-English **"What this does"** explanation,
- a ready-to-run **cURL** that replays it,
- the **response the system actually gave**, so you can compare.

Recognised call types:

| Direction | Source in log | Example |
|---|---|---|
| MI ➜ Infobip | `DOWNSTREAM_CALL = REQUEST/RESPONSE` | send MPIN flow, text, buttons |
| MI ➜ Infobip (media) | `IMG_CONVERT START \| url=` | download customer image |
| MI ➜ Antlere | `Token_API_URL`, `Customer to Agent DM Request` | live-agent token + ticket |
| MI ➜ Huawei CPS (SOAP) | `Envelope: <?xml …` + `DownstreamURLValue` | QueryIdentityInformation |
| Infobip ➜ MI | `Whatsapp Main - Request` | customer webhook (needs MI host) |
| CPS ➜ MI | `CPS - Result Message Dispatcher` | wallet callback (`cpscallexecute`) |

Everything runs client-side — logs containing API keys never leave the browser. "Mask secrets" redacts them for screenshots.

CLI equivalent (downstream calls only): `node ../tools/log2curl.mjs <logfile>`.
