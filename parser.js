/* Log2Curl — browser port of tools/log2curl.mjs. Pure, no network. */
(function (global) {
  'use strict';

  // Unwrap JSON-logged lines: {"@timestamp":..,"message":"..."} -> message
  function normalise(raw) {
    return raw.split('\n').map(line => {
      const t = line.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try { const o = JSON.parse(t); if (typeof o.message === 'string') return o.message; } catch (_) {}
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

  function pretty(json) { try { return JSON.stringify(JSON.parse(json), null, 2); } catch (_) { return json; } }

  // Infobip-style + generic success heuristics
  function judgeSuccess(responseJson, httpStatus) {
    if (httpStatus != null) return httpStatus >= 200 && httpStatus < 300;
    if (!responseJson) return null;
    let o; try { o = JSON.parse(responseJson); } catch (_) { return null; }
    if (o && o.requestError) return false;
    if (o && o.error) return false;
    if (o && o.status && typeof o.status === 'object') {
      const g = o.status.groupName || '';
      if (/REJECTED|UNDELIVERABLE|EXPIRED|FAILED/i.test(g)) return false;
      if (/PENDING|DELIVERED|ACCEPTED|OK|SUCCESS/i.test(g)) return true;
    }
    if (o && (o.messageId || o.messages)) return true;
    if (o && typeof o.status === 'string' && /fail|error|reject/i.test(o.status)) return false;
    return true;
  }

  function parse(raw) {
    const text = normalise(raw);
    const errors = [];

    const tokens = []; let tm;
    const tokenRe = /HeaderToken\s*=\s*([^\n"}]+)/gi;
    while ((tm = tokenRe.exec(text))) tokens.push(tm[1].trim());
    const authHeader = tokens.length ? tokens[tokens.length - 1] : null;

    const requests = [];
    const urlRe = /REQUEST_URL\s*=\s*(\S+?)(?=[,\s"]|$)/gi;
    let um;
    while ((um = urlRe.exec(text))) {
      const url = um[1].replace(/[,"]+$/, '');
      const from = um.index;
      const nextUrl = text.indexOf('REQUEST_URL', from + 10);
      const win = text.slice(from, nextUrl === -1 ? undefined : nextUrl);
      const before = text.slice(Math.max(0, from - 300), from);

      if (/DOWNSTREAM_CALL\s*=\s*RESPONSE/i.test(before)) {
        const rbIdx = win.search(/RESPONSE_BODY\s*=/i);
        const rb = rbIdx !== -1 ? extractBalanced(win, rbIdx).json : null;
        const stM = win.match(/(?:HTTP_SC|RESPONSE_CODE|STATUS_CODE|HTTP_STATUS)\s*=\s*(\d{3})/i);
        const httpStatus = stM ? Number(stM[1]) : null;
        const target = requests.slice().reverse().find(r => r.url === url && !r.response);
        if (target) { target.response = rb; target.httpStatus = httpStatus; target.success = judgeSuccess(rb, httpStatus); }
        continue;
      }

      const methodM = win.match(/REQUEST_METHOD\s*=\s*([A-Z]+)/i);
      const apiM = win.match(/API_NAME\s*=\s*([^,\n"]+)/i);
      const timeM = win.match(/REQUEST_TIME\s*=\s*([^,\n"]+)/i);

      let body = null, bodyComplete = true;
      const bIdx = win.search(/REQUEST_BODY\s*=/i);
      if (bIdx !== -1) { const r = extractBalanced(win, bIdx); body = r.json || null; bodyComplete = r.complete; }

      let headers = {};
      const hIdx = win.search(/REQUEST_HEADERS\s*=/i);
      if (hIdx !== -1) { try { headers = JSON.parse(extractBalanced(win, hIdx).json); } catch (_) {} }

      requests.push({
        url, method: methodM ? methodM[1].toUpperCase() : (body ? 'POST' : 'GET'),
        api: apiM ? apiM[1].trim() : null, time: timeM ? timeM[1].trim() : null,
        body, bodyComplete, headers, authHeader, response: null, success: null,
      });
    }
    if (!requests.length) errors.push('No REQUEST_URL found.');
    return { requests, errors };
  }

  function maskTok(v) {
    const m = String(v).match(/^(\w+\s+)?(.+)$/);
    const tok = m[2]; return (m[1] || '') + tok.slice(0, 6) + '…' + tok.slice(-4);
  }

  function toCurl(r, opts) {
    opts = opts || {};
    const parts = ['curl -sS -X ' + r.method + ' ' + shq(r.url)];
    const hdrs = Object.assign({}, r.headers);
    const has = k => Object.keys(hdrs).some(h => h.toLowerCase() === k);
    if (r.authHeader && !has('authorization')) hdrs['Authorization'] = opts.maskToken ? maskTok(r.authHeader) : r.authHeader;
    if (r.body && !has('content-type')) hdrs['Content-Type'] = 'application/json';
    if (!has('accept')) hdrs['Accept'] = 'application/json';
    Object.keys(hdrs).forEach(k => parts.push('  -H ' + shq(k + ': ' + hdrs[k])));
    if (r.body) parts.push('  --data ' + shq(pretty(r.body)));
    return parts.join(' \\\n');
  }

  const SAMPLE = `{"@timestamp":"2026-10-27 05:10:23,224","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} HeaderToken = App xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
{"@timestamp":"2026-10-27 05:10:23,226","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} DOWNSTREAM_CALL = REQUEST, REQUEST_TIME = 2026-10-27 05:10:23.226, API_NAME = JAZZCASH_WHATSAPP_VALIDATE_PIN_FLOW, REQUEST_URL = https://xxxxxx.api-pk2.infobip.com/whatsapp/1/message/interactive/flow, REQUEST_BODY = {
"from": "923000000000",
"to": "923000000001",
"content": {
"body": { "text": "Aap ki security ke liye barah-e-karam apna MPIN dobara darj karein." },
"action": {
"mode": "PUBLISHED",
"flowMessageVersion": 3,
"flowToken": "JC-AUTH-PIN-923000000001-20261027051023224",
"flowId": "1790179592136152",
"callToActionButton": "Jaari rakhein",
"flowAction": "NAVIGATE",
"flowActionPayload": { "screen": "MPIN_SCREEN", "data": { "heading": "MPIN ki Tasdeeq", "mpin_label": "MPIN", "button_label": "Jari Rakhein" } }
}
}
}, REQUEST_METHOD = POST"}
{"@timestamp":"2026-10-27 05:10:23,717","level":"DEBUG","component":"org.apache.synapse.mediators.builtin.LogMediator","message":"{api:JazzCash_WhatsApp} DOWNSTREAM_CALL = RESPONSE, RESPONSE_TIME = 2026-10-27 05:10:23.716, API_NAME = JAZZCASH_WHATSAPP_VALIDATE_PIN_FLOW, REQUEST_URL = https://xxxxxx.api-pk2.infobip.com/whatsapp/1/message/interactive/flow, RESPONSE_BODY = {"to":"923000000001","messageCount":1,"messageId":"af9862d9-68bb-440f-bc8f-d202d46402ab","status":{"groupId":1,"groupName":"PENDING","id":7,"name":"PENDING_ENROUTE","description":"Message sent to next instance"}}, REQUEST_METHOD = POST"}`;

  global.Log2Curl = { parse, toCurl, pretty, SAMPLE };
})(window);
