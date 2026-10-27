/* Log2Curl v2 — browser parser for JazzCash WhatsApp MI (WSO2 Synapse) logs. Pure, no network. */
(function (global) {
  'use strict';

  // ───────────────────────── helpers ─────────────────────────
  function normalise(raw) {
    return raw.split('\n').map(line => {
      const t = line.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try { const o = JSON.parse(t); const ts = o['@timestamp'] ? '@@TS:' + o['@timestamp'] + '@@ ' : '';
          if (typeof o.message === 'string') return ts + o.message; if (o.message && typeof o.message === 'object') return ts + JSON.stringify(o.message); } catch (_) {}
      }
      return line;
    }).join('\n');
  }
  function extractBalanced(src, startIdx) {
    let i = startIdx;
    while (i < src.length && src[i] !== '{' && src[i] !== '[') i++;
    if (i >= src.length) return { json: '', complete: false };
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return { json: src.slice(i, j + 1), complete: true }; }
    }
    return { json: src.slice(i).trim(), complete: false };
  }
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function pretty(s) { if (!s) return s; try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return prettyXml(s); } }
  function prettyXml(s) {
    if (!/^\s*</.test(s)) return s;
    const toks = s.replace(/>\s+</g, '><').match(/<[^>]+>|[^<]+/g) || [];
    let out = '', depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t[0] !== '<') continue; // text handled with its opening tag
      const isClose = /^<\//.test(t), isSelf = /\/>$/.test(t) || /^<[?!]/.test(t);
      const next = toks[i + 1], after = toks[i + 2];
      if (!isClose && !isSelf && next && next[0] !== '<' && after && /^<\//.test(after)) { // <a>text</a>
        out += '  '.repeat(depth) + t + next.trim() + after + '\n'; i += 2; continue;
      }
      if (isClose) depth = Math.max(0, depth - 1);
      out += '  '.repeat(depth) + t + '\n';
      if (!isClose && !isSelf) depth++;
    }
    return out.trim();
  }
  function tsToMs(t) { return t ? Date.parse(String(t).replace(',', '.').replace(' ', 'T') + 'Z') || 0 : 0; }
  function msToTs(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 23); }
  function lineTs(text, idx) { // nearest @timestamp or [ts] before idx (searched in raw text)
    const before = text.slice(Math.max(0, idx - 600), idx);
    const m = [...before.matchAll(/@@TS:([^@]+)@@/g)].pop();
    return m ? m[1].replace(',', '.') : null;
  }

  // ───────────────────────── knowledge: what each call is ─────────────────────────
  const INFOBIP_HOST = 'https://ee5nln.api-pk2.infobip.com';
  const KNOWLEDGE = [
    { match: /Whatsapp Main - Request$/i, kind: 'inbound', direction: 'Infobip ➜ MI (webhook)',
      urlHint: '{MI_HOST}/WABA/menu',
      what: 'This is the WhatsApp message a customer sent. Infobip forwards it to the MI\'s /WABA/menu endpoint. Replaying it simulates a customer sending that exact message (text, button tap, flow reply, or image).' },
    { match: /Customer to Agent DM Request/i, kind: 'downstream', direction: 'MI ➜ Antlere (live-agent DM API)',
      urlHint: 'https://interact.antlere.com:311/jazzcash/v1/{dm-endpoint — not in log}', auth: 'bearer',
      what: 'The MI hands the customer\'s message to the live-agent desk (Antlere). It creates or appends to a support ticket. Response tells you ticketId and whether it was "appended" or "reopened".' },
    { match: /Info Bip Text Request/i, kind: 'downstream', direction: 'MI ➜ Infobip',
      urlHint: INFOBIP_HOST + '/whatsapp/1/message/text', auth: 'app',
      what: 'Sends a plain WhatsApp text message to the customer via Infobip. The "to" number receives the "text".' },
    { match: /CPS - Result Message Dispatcher/i, kind: 'inbound', direction: 'Huawei CPS ➜ MI (callback)',
      urlHint: 'http://callback-staging-uat.apps.jpocp.jazz.com.pk/services/cpscallexecute',
      what: 'This is Huawei CPS (the core wallet) calling BACK into the MI with the result of an earlier request (e.g. MPIN check / balance). ResultCode 0 = OK; 2000 = wrong MPIN; 2002 / -1 "PIN is locked" = account locked.' },
  ];
  function knowledgeFor(channel) { return KNOWLEDGE.find(k => k.match.test(channel || '')) || null; }

  const API_WHAT = {
    JAZZCASH_WHATSAPP_VALIDATE_PIN_FLOW: 'Sends the customer an interactive WhatsApp Flow asking them to enter their MPIN. "text" is the prompt shown above the button; flowToken ties the reply back to this session.',
  };

  // ───────────────────────── parse ─────────────────────────
  function parse(raw) {
    const text = normalise(raw);
    const errors = [];
    const requests = [];
    const push = r => { r.ms = tsToMs(r.time); requests.push(r); return r; };

    // latest auth tokens seen (position-aware so each call gets the token logged just before it)
    const tokenPos = [...text.matchAll(/HeaderToken\s*=\s*([^\n"}]+)/gi)].map(m => ({ i: m.index, v: m[1].trim() }));
    const tokenBefore = idx => { let v = null; for (const t of tokenPos) { if (t.i < idx) v = t.v; else break; } return v || (tokenPos[0] && tokenPos[0].v) || null; };
    const bearerPos = [...text.matchAll(/\bToken\s*=\s*(eyJ[A-Za-z0-9._-]+)/g)].map(m => ({ i: m.index, v: m[1] }));
    const bearerBefore = idx => { let v = null; for (const t of bearerPos) { if (t.i < idx) v = t.v; else break; } return v || (bearerPos[0] && bearerPos[0].v) || null; };

    // 1) DOWNSTREAM_CALL = REQUEST/RESPONSE (MI ➜ Infobip)
    const urlRe = /REQUEST_URL\s*=\s*(\S+?)(?=[,\s"]|$)/gi; let um;
    while ((um = urlRe.exec(text))) {
      const url = um[1].replace(/[,"]+$/, ''); const from = um.index;
      const nextUrl = text.indexOf('REQUEST_URL', from + 10);
      const win = text.slice(from, nextUrl === -1 ? undefined : nextUrl);
      const before = text.slice(Math.max(0, from - 300), from);
      if (/DOWNSTREAM_CALL\s*=\s*RESPONSE/i.test(before)) {
        const rbIdx = win.search(/RESPONSE_BODY\s*=/i);
        const rb = rbIdx !== -1 ? extractBalanced(win, rbIdx).json : null;
        const target = requests.slice().reverse().find(r => r.url === url && !r.response);
        if (target) { target.response = rb; target.success = judgeSuccess(rb); }
        continue;
      }
      const methodM = win.match(/REQUEST_METHOD\s*=\s*([A-Z]+)/i);
      const apiM = win.match(/API_NAME\s*=\s*([^,\n"]+)/i);
      const timeM = before.match(/REQUEST_TIME\s*=\s*([^,\n"]+)/i) || win.match(/REQUEST_TIME\s*=\s*([^,\n"]+)/i);
      let body = null, bodyComplete = true;
      const bIdx = win.search(/REQUEST_BODY\s*=/i);
      if (bIdx !== -1) { const r = extractBalanced(win, bIdx); body = r.json || null; bodyComplete = r.complete; }
      const api = apiM ? apiM[1].trim() : null;
      push({ kind: 'downstream', direction: 'MI ➜ Infobip', url, method: methodM ? methodM[1].toUpperCase() : (body ? 'POST' : 'GET'),
        api, time: timeM ? timeM[1].trim() : lineTs(text, from), body, bodyComplete, headers: {}, authHeader: tokenBefore(from),
        response: null, success: null, what: API_WHAT[api] || 'Call from the MI to Infobip.', urlKnown: true });
    }

    // 2) EVENT_LOG REQUEST_LOGGING / RESPONSE_LOGGING (paired by CORRELATION_ID, nearest-preceding)
    const evReqRe = /"REQUEST_LOGGING"\s*:\s*/g; let em;
    while ((em = evReqRe.exec(text))) {
      const { json, complete } = extractBalanced(text, em.index + em[0].length);
      const pick = k => { const m = json.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')); return m ? m[1] : null; };
      let payload = null, payloadComplete = complete;
      const pIdx = json.search(/"REQUEST_PAYLOAD"\s*:/);
      if (pIdx !== -1) { const r = extractBalanced(json, pIdx + 17); payload = r.json || null; payloadComplete = r.complete; }
      const channel = pick('CHANNEL') || 'EVENT_LOG_REQUEST';
      const k = knowledgeFor(channel);
      const api = (text.slice(Math.max(0, em.index - 60), em.index).match(/"API"\s*:\s*"([^"]*)"/) || [])[1];
      // CPS callback body is XML inside ResultMsg → unwrap for a faithful replay
      let body = payload, bodyIsXml = false;
      if (k && /CPS - Result/i.test(channel) && payload) { try { const o = JSON.parse(payload); if (o.ResultMsg) { body = o.ResultMsg; bodyIsXml = true; } } catch (_) {} }
      const auth = k && k.auth === 'app' ? tokenBefore(em.index) : k && k.auth === 'bearer' ? (bearerBefore(em.index) ? 'Bearer ' + bearerBefore(em.index) : null) : null;
      push({ kind: k ? k.kind : 'event', direction: k ? k.direction : 'unknown', url: k && !/\{/.test(k.urlHint) ? k.urlHint : null, urlHint: k ? k.urlHint : null, urlKnown: !!(k && !/\{/.test(k.urlHint)),
        method: 'POST', api: [api, channel].filter(Boolean).join(' · '), channel, time: pick('TIMESTAMP') || lineTs(text, em.index),
        correlationId: pick('CORRELATION_ID'), tranId: pick('TRAN_ID'), msisdn: pick('MSISDN'),
        body, bodyIsXml, bodyComplete: payloadComplete, headers: {}, authHeader: auth, response: null, success: null,
        what: k ? k.what : 'Event logged by the MI (' + channel + ').' });
    }
    const evResRe = /"RESPONSE_LOGGING"\s*:\s*/g;
    while ((em = evResRe.exec(text))) {
      const { json } = extractBalanced(text, em.index + em[0].length);
      const cidM = json.match(/"CORRELATION_ID"\s*:\s*"([^"]*)"/); const cid = cidM ? cidM[1] : null;
      const chM = json.match(/"CHANNEL"\s*:\s*"([^"]*)"/); const rch = chM ? chM[1] : '';
      const rIdx = json.search(/"RESPONSE"\s*:/);
      const resp = rIdx !== -1 ? extractBalanced(json, rIdx + 10).json : null;
      // Prefer: same correlation + matching channel family (DM Request ↔ DM Response, Text Request ↔ Text Response)
      const fam = s => (s || '').replace(/\s*-\s*(Request|Response)$/i, '').replace(/Info Bip Button Response/i, 'Info Bip Button');
      const cands = requests.filter(r => r.correlationId && r.correlationId === cid && !r.response && r.ms <= tsToMs(json.match(/"TIMESTAMP"\s*:\s*"([^"]*)"/)?.[1]) + 1);
      let target = cands.slice().reverse().find(r => fam(r.channel) === fam(rch)) || cands.slice().reverse()[0];
      if (!target && /Button Response/i.test(rch)) { // Infobip button-send reply with no logged request → synthesize
        target = push({ kind: 'downstream', direction: 'MI ➜ Infobip', url: INFOBIP_HOST + '/whatsapp/1/message/interactive/buttons', urlKnown: true, method: 'POST',
          api: 'Whatsapp Main - Info Bip Button (request body not logged)', channel: rch, time: json.match(/"TIMESTAMP"\s*:\s*"([^"]*)"/)?.[1] || lineTs(text, em.index),
          correlationId: cid, body: null, bodyComplete: true, headers: {}, authHeader: tokenBefore(em.index), response: null, success: null,
          what: 'The MI sent the customer a WhatsApp message with buttons (e.g. "Talk to an Agent"). Only the Infobip response was logged, so the body must be reconstructed.' });
      }
      if (target) { target.response = resp; target.success = judgeSuccess(resp); }
    }

    // 3) Huawei CPS SOAP request / response (Envelope in log) — URL from DownstreamURLValue, SOAPAction + Cookie from CPS_API lines
    const cpsUrl = (text.match(/DownstreamURLValue\s*=\s*(\S+?)(?=[,\s"])/) || [])[1] || 'http://{CPS_HOST}/payment/services/RequestMgrService';
    const soapAction = (text.match(/SOAPAction\s*=\s*([^,\n"]+)/) || [])[1];
    const cookie = (text.match(/Cookie\s*=\s*([^,\n"]+)/) || [])[1];
    const soapRe = /Direction:\s*request,\s*Envelope:\s*(<\?xml[\s\S]*?<\/soapenv:Envelope>)/g;
    while ((em = soapRe.exec(text))) {
      const env = em[1];
      const isResp = /<api:Response/.test(env);
      const ocid = (env.match(/OriginatorConversationID>([^<]+)</) || [])[1];
      if (isResp) {
        const t = requests.slice().reverse().find(r => r.kind === 'soap' && r.ocid === ocid && !r.response);
        if (t) { t.response = env; const rc = (env.match(/ResponseCode>([^<]+)</) || [])[1]; t.success = rc === '0'; }
        continue;
      }
      const cmd = (env.match(/CommandID>([^<]+)</) || [])[1];
      const hdrs = { 'Content-Type': 'text/xml; charset=utf-8' };
      if (soapAction) hdrs['SOAPAction'] = soapAction; if (cookie) hdrs['Cookie'] = cookie;
      push({ kind: 'soap', direction: 'MI ➜ Huawei CPS (core wallet, SOAP)', url: cpsUrl, urlKnown: !/\{/.test(cpsUrl), method: 'POST', api: 'CPS · ' + (cmd || 'Request'), ocid,
        time: lineTs(text, em.index), body: env, bodyIsXml: true, bodyComplete: true, headers: hdrs, authHeader: null, response: null, success: null,
        what: cmd === 'QueryIdentityInformation'
          ? 'Asks the core wallet (Huawei CPS) to verify the customer\'s MPIN and identity. SecurityCredential is the encrypted MPIN. CPS answers "accepted" here (ResponseCode 0) and sends the real result later via the callback.'
          : 'SOAP request to the core wallet (Huawei CPS), command ' + cmd + '.' });
    }

    // 4) Antlere token call (Basic auth → JWT)
    const tokUrl = (text.match(/Token_API_URL\s*=\s*(\S+?)(?=[,\s"])/) || [])[1];
    if (tokUrl) {
      const idx = text.indexOf('Token_API_URL');
      const basic = (text.match(/agent_token_AUTHORIZATION\s*=\s*([^\n"]+)/) || [])[1];
      const jwt = (text.slice(idx).match(/\bToken\s*=\s*(eyJ[A-Za-z0-9._-]+)/) || [])[1];
      push({ kind: 'downstream', direction: 'MI ➜ Antlere (auth)', url: tokUrl, urlKnown: true, method: 'POST', api: 'Antlere · generate-token', time: lineTs(text, idx),
        body: null, bodyComplete: true, headers: {}, authHeader: basic ? basic.trim() : null, response: jwt ? JSON.stringify({ token: jwt }) : null, success: jwt ? true : null,
        what: 'Logs the MI into the Antlere live-agent API using client-id/secret (Basic auth) and gets back a JWT. That JWT is then used as "Bearer" on the DM Request calls. The MI caches it in Redis.' });
    }

    // 5) Media download from Infobip (GET)
    const imgRe = /IMG_CONVERT START \| url=(\S+)/g;
    while ((em = imgRe.exec(text))) {
      const url = em[1];
      const authM = text.slice(Math.max(0, em.index - 3000), em.index).match(/AUTH_TOKEN\s*=\s*(App [^\n",]+)/);
      const after = text.slice(em.index, em.index + 2000);
      const sc = (after.match(/IMG_CONVERT HTTP \| (\d{3})/) || [])[1];
      const chk = (after.match(/IMG_CONVERT CHECK \| ([^\n"]+)/) || [])[1];
      push({ kind: 'downstream', direction: 'MI ➜ Infobip (media)', url, urlKnown: true, method: 'GET', api: 'Infobip · download media', time: lineTs(text, em.index),
        body: null, bodyComplete: true, headers: {}, authHeader: authM ? authM[1].trim() : tokenBefore(em.index), extraCurl: ' \\\n  --output downloaded-media.jpg',
        response: sc ? JSON.stringify({ http: Number(sc), check: chk || null }) : null, success: sc ? sc.startsWith('2') : null,
        what: 'Downloads the image/document the customer sent on WhatsApp so the MI can scan it (type/size) and forward it to the agent desk as base64. Run this and you get the file itself.' });
    }

    requests.sort((a, b) => a.ms - b.ms);
    if (!requests.length) errors.push('No requests found. Paste WSO2 MI log-mediator output (DOWNSTREAM_CALL, EVENT_LOG, SOAP Envelope…).');
    return { requests, errors };
  }

  function judgeSuccess(json) {
    if (!json) return null;
    let o; try { o = JSON.parse(json); } catch (_) { return null; }
    if (o.requestError || o.error) return false;
    if (o.success === false) return false;
    if (o.success === true) return true;
    if (typeof o.code === 'number') return o.code >= 200 && o.code < 300;
    if (o.status && typeof o.status === 'object') {
      const g = o.status.groupName || '';
      if (/REJECTED|UNDELIVERABLE|EXPIRED|FAILED/i.test(g)) return false;
      if (/PENDING|DELIVERED|ACCEPTED|OK|SUCCESS/i.test(g)) return true;
    }
    if (o.messageId || o.messages) return true;
    return true;
  }

  // ───────────────────────── render ─────────────────────────
  function maskTok(v) { const m = String(v).match(/^(\w+\s+)?(.+)$/); const tok = m[2]; return (m[1] || '') + tok.slice(0, 6) + '…' + tok.slice(-4); }
  function stripAttachments(body) { // replace giant base64 "data" with a placeholder for display
    return body.replace(/("data"\s*:\s*")([A-Za-z0-9+/=]{200,})(")/g, (_, a, b, c) => a + '<' + b.length + ' chars of base64 — kept in Copy/Download>' + c);
  }
  function resolveUrl(r, opts) {
    if (r.url) return r.url;
    const hint = r.urlHint || 'https://{HOST}/{path-not-in-log}';
    return hint.replace('{MI_HOST}', (opts.miHost || '').trim().replace(/\/$/, '') || 'http://{MI_HOST}:8290');
  }
  function toCurl(r, opts) {
    opts = opts || {};
    const url = resolveUrl(r, opts);
    const parts = ['curl -sS -X ' + r.method + ' ' + shq(url)];
    const hdrs = Object.assign({}, r.headers);
    const has = k => Object.keys(hdrs).some(h => h.toLowerCase() === k);
    if (r.authHeader && !has('authorization')) hdrs['Authorization'] = opts.maskToken ? maskTok(r.authHeader) : r.authHeader;
    if (r.correlationId) hdrs['X-Correlation-ID'] = r.correlationId;
    if (r.body && !has('content-type')) hdrs['Content-Type'] = r.bodyIsXml ? 'text/xml; charset=utf-8' : 'application/json';
    if (!has('accept')) hdrs['Accept'] = r.bodyIsXml ? 'text/xml, application/json' : 'application/json';
    Object.keys(hdrs).forEach(k => parts.push('  -H ' + shq(k + ': ' + hdrs[k])));
    if (r.body) {
      let b = r.bodyIsXml ? prettyXml(r.body) : pretty(r.body);
      if (opts.forDisplay) b = stripAttachments(b);
      parts.push('  --data ' + shq(b));
    }
    return parts.join(' \\\n') + (r.extraCurl || '');
  }

  const GLOSSARY = [
    ['curl', 'the command-line tool that sends an HTTP request — exactly what the MI did, but from your terminal'],
    ['-X POST', 'the HTTP method (POST = send data, GET = fetch)'],
    ['-sS', 'quiet mode, but still show errors'],
    ['-H \'Name: value\'', 'a header. Authorization carries the API key/token; Content-Type says what format the body is'],
    ['--data \'…\'', 'the body — the actual payload sent'],
    ['--output file', 'save the response to a file instead of printing it (used for media downloads)'],
    ['\\ at line end', 'just means "the command continues on the next line" — paste the whole block as one'],
  ];

  const SAMPLE = `{"@timestamp":"2026-10-27 05:52:02,240","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} HeaderToken = App xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
{"@timestamp":"2026-10-27 05:52:02,241","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} DOWNSTREAM_CALL = REQUEST, REQUEST_TIME = 2026-10-27 05:52:02.241, API_NAME = JAZZCASH_WHATSAPP_VALIDATE_PIN_FLOW, REQUEST_URL = https://ee5nln.api-pk2.infobip.com/whatsapp/1/message/interactive/flow, REQUEST_BODY = {
 "from": "923067707468", "to": "923000000000",
 "content": { "body": { "text": "Your session has expired. Please enter your MPIN again." },
 "action": { "mode": "PUBLISHED", "flowMessageVersion": 3, "flowToken": "JC-AUTH-PIN-923000000000-20261027055202240", "flowId": "1790179592136152", "callToActionButton": "Continue", "flowAction": "NAVIGATE",
 "flowActionPayload": { "screen": "MPIN_SCREEN", "data": { "heading": "MPIN Verification", "mpin_label": "MPIN", "button_label": "Continue" } } } }
 }, REQUEST_METHOD = POST"}
{"@timestamp":"2026-10-27 05:52:03,228","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} DOWNSTREAM_CALL = RESPONSE, RESPONSE_TIME = 2026-10-27 05:52:03.228, API_NAME = JAZZCASH_WHATSAPP_VALIDATE_PIN_FLOW, REQUEST_URL = https://ee5nln.api-pk2.infobip.com/whatsapp/1/message/interactive/flow, RESPONSE_BODY = {"to":"923000000000","messageCount":1,"messageId":"2164ed24-c3d9-4ce4-af0a-2f08bb0b11e2","status":{"groupId":1,"groupName":"PENDING","id":7,"name":"PENDING_ENROUTE","description":"Message sent to next instance"}}, REQUEST_METHOD = POST"}
{"@timestamp":"2026-10-27 05:53:08,610","level":"INFO","component":"org.apache.synapse.mediators.builtin.LogMediator","message":{"API":"WhatsApp MAIN","REQUEST_LOGGING":{"LOG_TYPE":"EVENT_LOG_REQUEST","CORRELATION_ID":"e18fcfce-6c27-4f16-ad26-dd100fce70d7","TRAN_ID":"270553070852","INTERFACE":"WhatsApp","STAGE":"MI","TIMESTAMP":"2026-10-27 05:53:08","CHANNEL":"Whatsapp Main - Customer to Agent DM Request","SERVER_IP":"11.131.0.215","MSISDN":"923000000000","REQUEST_PAYLOAD":{"customerName":"Test User","customerNumber":"923000000000","messageId":"92300000000020261027055307926","message":"first query","messageTimeStamp":"20261027055308610"}}}}
{"@timestamp":"2026-10-27 05:53:08,758","level":"INFO","component":"org.apache.synapse.mediators.builtin.LogMediator","message":{"API":"WhatsApp MAIN","RESPONSE_LOGGING":{"LOG_TYPE":"EVENT_LOG_RESPONSE","CORRELATION_ID":"e18fcfce-6c27-4f16-ad26-dd100fce70d7","TRAN_ID":"270553070852","INTERFACE":"WhatsApp","STAGE":"MI","TIMESTAMP":"2026-10-27 05:53:08","CHANNEL":"Whatsapp Main - Customer to Agent DM Response","SERVER_IP":"11.131.0.215","MSISDN":"923000000000","STATUS:":"","RESPONSE":{"code":200,"success":true,"message":"success","data":{"ticketId":"JazzCash-W-273094","outcome":"reopened","messageId":"92300000000020261027055307926"}}}}}`;

  global.Log2Curl = { parse, toCurl, pretty, prettyXml, stripAttachments, resolveUrl, GLOSSARY, SAMPLE };
})(window);
