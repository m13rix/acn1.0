export function renderRealtimeAdvisorClientHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Realtime Advisor Console</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1c2328;
      --muted: #687178;
      --line: #d6ddd8;
      --panel: #f7f8f2;
      --panel-2: #eef3f0;
      --accent: #0e766a;
      --accent-2: #b33b2e;
      --gold: #9a741f;
      --blue: #315f8a;
      --white: #fffdfa;
      --shadow: 0 18px 42px rgba(34, 46, 44, 0.12);
      --radius: 8px;
      font-family: "Aptos", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(14, 118, 106, 0.08) 1px, transparent 1px),
        linear-gradient(180deg, rgba(49, 95, 138, 0.06) 1px, transparent 1px),
        #eceee7;
      background-size: 28px 28px;
    }

    button, input, textarea, select {
      font: inherit;
    }

    .shell {
      width: min(1460px, calc(100vw - 28px));
      margin: 14px auto;
      display: grid;
      grid-template-columns: minmax(310px, 430px) minmax(0, 1fr);
      gap: 14px;
    }

    header {
      grid-column: 1 / -1;
      min-height: 78px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 16px;
      padding: 18px 20px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 250, 0.82);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }

    h1 {
      margin: 0;
      font-size: clamp(26px, 3vw, 48px);
      line-height: 0.96;
      letter-spacing: 0;
      font-weight: 760;
    }

    .status {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
      color: var(--muted);
      font-size: 13px;
    }

    .pill {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--white);
      white-space: nowrap;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--gold);
    }

    .dot.ok { background: var(--accent); }
    .dot.err { background: var(--accent-2); }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 253, 250, 0.9);
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .panel h2 {
      margin: 0;
      padding: 14px 16px 10px;
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #293338;
      border-bottom: 1px solid var(--line);
    }

    .stack {
      display: grid;
      gap: 14px;
    }

    .form {
      display: grid;
      gap: 12px;
      padding: 14px;
    }

    label {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    input, textarea, select {
      width: 100%;
      border: 1px solid #c9d3ce;
      border-radius: 6px;
      background: #fffef9;
      color: var(--ink);
      padding: 10px 11px;
      outline: none;
    }

    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(14, 118, 106, 0.14);
    }

    textarea {
      min-height: 86px;
      resize: vertical;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      min-height: 38px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--ink);
      color: white;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      justify-content: center;
    }

    button.secondary {
      background: #fffef9;
      color: var(--ink);
      border-color: #c9d3ce;
    }

    button.danger {
      background: var(--accent-2);
    }

    button:disabled {
      opacity: 0.55;
      cursor: progress;
    }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 7px 10px;
      border: 1px solid #c9d3ce;
      border-radius: 6px;
      background: #fffef9;
      color: var(--ink);
      text-transform: none;
      letter-spacing: 0;
      font-size: 14px;
    }

    .toggle input { width: auto; }

    .main {
      display: grid;
      grid-template-rows: auto auto minmax(260px, 1fr);
      gap: 14px;
      min-width: 0;
    }

    .meter {
      height: 118px;
      width: 100%;
      background:
        linear-gradient(90deg, rgba(28, 35, 40, 0.09) 1px, transparent 1px),
        linear-gradient(180deg, rgba(28, 35, 40, 0.08) 1px, transparent 1px),
        #f9faf5;
      background-size: 18px 18px;
      border-bottom: 1px solid var(--line);
    }

    .transcript {
      min-height: 310px;
      max-height: 54vh;
      overflow: auto;
      padding: 10px 14px 16px;
      background: #fffef9;
      border-radius: 0 0 var(--radius) var(--radius);
    }

    .line {
      display: grid;
      grid-template-columns: minmax(86px, 150px) minmax(0, 1fr);
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(214, 221, 216, 0.75);
    }

    .speaker {
      color: var(--blue);
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
    }

    .response {
      padding: 14px;
      min-height: 94px;
      white-space: pre-wrap;
      background: var(--panel-2);
      border-radius: 0 0 var(--radius) var(--radius);
      overflow-wrap: anywhere;
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .table th, .table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    .table th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
      background: #f7f8f2;
    }

    audio {
      width: min(260px, 100%);
      height: 34px;
    }

    .small {
      font-size: 12px;
      color: var(--muted);
    }

    .log {
      height: 180px;
      overflow: auto;
      padding: 12px;
      color: #2f383d;
      background: #fbfaf3;
      border-radius: 0 0 var(--radius) var(--radius);
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      white-space: pre-wrap;
    }

    .qr-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(28, 35, 40, 0.42);
      z-index: 20;
    }

    .qr-backdrop.open { display: flex; }

    .qr-dialog {
      width: min(380px, calc(100vw - 28px));
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow);
      padding: 14px;
      display: grid;
      gap: 12px;
    }

    .qr-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .qr-box {
      display: grid;
      place-items: center;
      min-height: 260px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfaf3;
    }

    .qr-box img {
      width: min(248px, 80vw);
      height: min(248px, 80vw);
      image-rendering: pixelated;
    }

    .url-line {
      overflow-wrap: anywhere;
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      color: #2f383d;
    }

    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }
      header {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .status {
        justify-content: flex-start;
      }
    }

    @media (max-width: 560px) {
      .shell {
        width: calc(100vw - 18px);
        margin: 9px auto;
      }
      .row, .line {
        grid-template-columns: 1fr;
      }
      h1 {
        font-size: 30px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Realtime Advisor Console</h1>
        <div class="small" id="baseUrl"></div>
      </div>
      <div class="status">
        <span class="pill"><span class="dot" id="healthDot"></span><span id="healthText">checking</span></span>
        <button type="button" class="secondary" id="showQr">Show QR</button>
        <span class="pill" id="conversationPill">no conversation</span>
      </div>
    </header>

    <aside class="stack">
      <section class="panel">
        <h2>Chunk</h2>
        <form class="form" id="chunkForm">
          <label>Audio
            <input name="audio" type="file" accept="audio/*" required />
          </label>
          <label>Quick transcript
            <textarea name="quickTranscript" placeholder="да, вот сейчас он пишет разговор..."></textarea>
          </label>
          <div class="row">
            <label>Chunk id
              <input name="chunkId" placeholder="auto" />
            </label>
            <label>Timestamp
              <input name="timestamp" placeholder="now" />
            </label>
          </div>
          <div class="toolbar">
            <label class="toggle"><input name="immediateAdvice" type="checkbox" /> immediate advice</label>
            <button type="submit" id="sendChunk">Send chunk</button>
            <button type="button" class="secondary" id="refresh">Refresh</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2>Manual Speaker</h2>
        <form class="form" id="speakerForm">
          <label>Name
            <input name="name" required placeholder="Subject 13" />
          </label>
          <label>Description
            <textarea name="description" placeholder="short speaker note"></textarea>
          </label>
          <label>Sample
            <input name="audio" type="file" accept="audio/*" required />
          </label>
          <button type="submit">Add speaker</button>
        </form>
      </section>

      <section class="panel">
        <h2>Log</h2>
        <div class="log" id="log"></div>
      </section>
    </aside>

    <section class="main">
      <section class="panel">
        <canvas class="meter" id="wave" width="1200" height="118"></canvas>
        <div class="response" id="advice">No advice response yet.</div>
      </section>

      <section class="panel">
        <h2>Pending Speakers</h2>
        <div style="overflow:auto">
          <table class="table">
            <thead>
              <tr><th>Temp id</th><th>Sample</th><th>Resolve</th></tr>
            </thead>
            <tbody id="pendingRows"></tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <h2>Current Transcript</h2>
        <div class="transcript" id="transcript"></div>
      </section>
    </section>
  </main>

  <div class="qr-backdrop" id="qrBackdrop" aria-hidden="true">
    <div class="qr-dialog" role="dialog" aria-modal="true" aria-labelledby="qrTitle">
      <div class="qr-head">
        <strong id="qrTitle">Phone connection</strong>
        <button type="button" class="secondary" id="closeQr">Close</button>
      </div>
      <div class="qr-box" id="qrBox"></div>
      <div class="url-line" id="qrUrl"></div>
      <div class="toolbar">
        <button type="button" id="copyPublicUrl">Copy URL</button>
        <button type="button" class="secondary" id="openPublicUrl">Open</button>
      </div>
    </div>
  </div>

  <script>
    const $ = (selector) => document.querySelector(selector);
    const logEl = $('#log');
    const transcriptEl = $('#transcript');
    const pendingRows = $('#pendingRows');
    const adviceEl = $('#advice');
    const healthDot = $('#healthDot');
    const healthText = $('#healthText');
    const conversationPill = $('#conversationPill');
    const qrBackdrop = $('#qrBackdrop');
    const qrBox = $('#qrBox');
    const qrUrl = $('#qrUrl');
    const wave = $('#wave');
    const ctx = wave.getContext('2d');
    let busy = false;
    let connectionUrl = location.origin;

    $('#baseUrl').textContent = location.origin;

    function log(line) {
      const stamp = new Date().toLocaleTimeString();
      logEl.textContent = '[' + stamp + '] ' + line + '\n' + logEl.textContent;
    }

    function setBusy(next) {
      busy = next;
      document.querySelectorAll('button').forEach((button) => button.disabled = next);
    }

    async function jsonFetch(url, options) {
      const response = await fetch(url, options);
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!response.ok) {
        throw new Error(body.error || text || 'HTTP ' + response.status);
      }
      return body;
    }

    function setConnectionUrl(url, status) {
      connectionUrl = url || location.origin;
      $('#baseUrl').textContent = status ? connectionUrl + ' · tunnel ' + status : connectionUrl;
      if (qrBackdrop.classList.contains('open')) renderQr();
    }

    function renderQr() {
      const clientUrl = connectionUrl.replace(/\/+$/, '') + '/client';
      const qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=248x248&margin=12&data=' + encodeURIComponent(clientUrl);
      qrBox.innerHTML = '<img alt="QR code for phone connection" src="' + qrImageUrl + '" />';
      qrUrl.textContent = clientUrl;
    }

    function drawWave() {
      const width = wave.width;
      const height = wave.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#f9faf5';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#0e766a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const t = Date.now() / 520;
      for (let x = 0; x < width; x += 5) {
        const y = height / 2
          + Math.sin(x / 28 + t) * 24
          + Math.sin(x / 67 - t * 0.7) * 13
          + Math.sin(x / 11 + t * 1.6) * 3;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(179, 59, 46, 0.7)';
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      requestAnimationFrame(drawWave);
    }
    drawWave();

    function renderTranscript(conversation) {
      if (!conversation) {
        transcriptEl.innerHTML = '<div class="small">No transcript yet.</div>';
        conversationPill.textContent = 'no conversation';
        return;
      }
      conversationPill.textContent = conversation.id + ' · ' + conversation.entries.length + ' lines';
      transcriptEl.innerHTML = '';
      for (const entry of conversation.entries) {
        const row = document.createElement('div');
        row.className = 'line';
        const speaker = document.createElement('div');
        speaker.className = 'speaker';
        speaker.textContent = entry.speakerLabel || '[...]';
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = entry.text;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (entry.final ? 'final' : 'quick') + ' · ' + new Date(entry.startTime).toLocaleTimeString();
        text.appendChild(meta);
        row.appendChild(speaker);
        row.appendChild(text);
        transcriptEl.appendChild(row);
      }
    }

    function renderPending(items) {
      pendingRows.innerHTML = '';
      if (!items.length) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="3" class="small">No pending speakers.</td>';
        pendingRows.appendChild(row);
        return;
      }
      for (const item of items) {
        const row = document.createElement('tr');
        const sampleUrl = item.sampleUrl || '';
        row.innerHTML = '<td><strong>' + item.id + '</strong><div class="small">' + Number(item.speechSeconds || 0).toFixed(1) + 's</div></td>'
          + '<td>' + (sampleUrl ? '<audio controls src="' + sampleUrl + '"></audio>' : '<span class="small">no sample</span>') + '</td>'
          + '<td><form data-temp="' + item.id + '" class="resolveForm">'
          + '<input name="name" placeholder="new or existing name" required />'
          + '<textarea name="description" placeholder="description"></textarea>'
          + '<div class="toolbar"><button type="submit">Resolve</button><button type="button" class="secondary dismiss">Dismiss</button></div>'
          + '</form></td>';
        pendingRows.appendChild(row);
      }
    }

    async function refresh() {
      try {
        const health = await jsonFetch('/health');
        healthDot.className = 'dot ok';
        const tunnel = health.tunnel || {};
        const tunnelText = health.publicUrl ? 'public' : (tunnel.enabled ? tunnel.status : 'local');
        healthText.textContent = (health.pyannoteEnabled ? 'online · pyannote' : 'online · local') + ' · ' + tunnelText;
        setConnectionUrl(health.publicUrl || health.baseUrl || location.origin, tunnel.enabled ? tunnel.status : 'disabled');
        const state = await jsonFetch('/v1/state');
        renderTranscript(state.currentConversation);
        renderPending(state.pendingSpeakers || []);
      } catch (error) {
        healthDot.className = 'dot err';
        healthText.textContent = 'offline';
        log('refresh failed: ' + error.message);
      }
    }

    $('#refresh').addEventListener('click', refresh);

    $('#showQr').addEventListener('click', () => {
      renderQr();
      qrBackdrop.classList.add('open');
      qrBackdrop.setAttribute('aria-hidden', 'false');
    });

    $('#closeQr').addEventListener('click', () => {
      qrBackdrop.classList.remove('open');
      qrBackdrop.setAttribute('aria-hidden', 'true');
    });

    qrBackdrop.addEventListener('click', (event) => {
      if (event.target === qrBackdrop) {
        qrBackdrop.classList.remove('open');
        qrBackdrop.setAttribute('aria-hidden', 'true');
      }
    });

    $('#copyPublicUrl').addEventListener('click', async () => {
      const value = qrUrl.textContent || (connectionUrl + '/client');
      try {
        await navigator.clipboard.writeText(value);
        log('copied phone URL');
      } catch {
        log('copy failed: ' + value);
      }
    });

    $('#openPublicUrl').addEventListener('click', () => {
      window.open(qrUrl.textContent || (connectionUrl + '/client'), '_blank', 'noopener,noreferrer');
    });

    $('#chunkForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      if (!data.get('chunkId')) data.delete('chunkId');
      if (!data.get('timestamp')) data.delete('timestamp');
      data.set('immediateAdvice', form.immediateAdvice.checked ? 'true' : 'false');
      setBusy(true);
      try {
        const body = await jsonFetch('/v1/chunks', { method: 'POST', body: data });
        log('chunk accepted: ' + body.chunkId);
        if (body.advice) adviceEl.textContent = body.advice;
        if (body.newSpeakers && body.newSpeakers.length) log('new speaker proposals: ' + body.newSpeakers.length);
        form.chunkId.value = '';
        await refresh();
      } catch (error) {
        log('chunk failed: ' + error.message);
      } finally {
        setBusy(false);
      }
    });

    $('#speakerForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      setBusy(true);
      try {
        const body = await jsonFetch('/v1/speakers', { method: 'POST', body: data });
        log('speaker added: ' + body.speaker.name);
        form.reset();
        await refresh();
      } catch (error) {
        log('speaker add failed: ' + error.message);
      } finally {
        setBusy(false);
      }
    });

    pendingRows.addEventListener('click', async (event) => {
      if (!event.target.classList.contains('dismiss')) return;
      const form = event.target.closest('form');
      const tempId = form.dataset.temp;
      setBusy(true);
      try {
        await jsonFetch('/v1/speakers/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolutions: [{ tempId, dismiss: true }] }),
        });
        log('dismissed: ' + tempId);
        await refresh();
      } catch (error) {
        log('dismiss failed: ' + error.message);
      } finally {
        setBusy(false);
      }
    });

    pendingRows.addEventListener('submit', async (event) => {
      if (!event.target.classList.contains('resolveForm')) return;
      event.preventDefault();
      const form = event.target;
      const tempId = form.dataset.temp;
      const name = form.name.value.trim();
      const description = form.description.value.trim();
      setBusy(true);
      try {
        const body = await jsonFetch('/v1/speakers/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolutions: [{ tempId, name, description }] }),
        });
        log('resolved: ' + tempId + ' -> ' + (body.results?.[0]?.speaker?.name || name));
        await refresh();
      } catch (error) {
        log('resolve failed: ' + error.message);
      } finally {
        setBusy(false);
      }
    });

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
