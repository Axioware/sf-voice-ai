;(function () {
  'use strict'

  const api = window.electronAPI
  const $   = id => document.getElementById(id)

  // ── State ──────────────────────────────────────────────────────────────────
  let callActive    = false
  let callStartTime = null
  let timerInterval = null
  let alwaysOnTop   = true
  // Track interim bubble per channel so we can update it in place
  const interimBubble = { lead: null, agent: null }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const statusDot    = $('status-dot')
  const statusText   = $('status-text')
  const btnCall      = $('btn-call')
  const callLabel    = $('call-label')
  const btnClearChat = $('btn-clear-chat')
  const btnSettings  = $('btn-settings')
  const btnPin       = $('btn-pin')
  const btnMin       = $('btn-min')
  const btnClose     = $('btn-close')
  const callTimer    = $('call-timer')
  const dgBadge      = $('dg-badge')
  const thinking     = $('thinking')
  const aiBody       = $('ai-body')
  const chatWindow   = $('chat-window')
  const chatEmpty    = $('chat-empty')
  const errorBanner  = $('error-banner')
  const errorText    = $('error-text')
  const viewMain     = $('view-main')
  const viewSettings = $('view-settings')

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    attachEventListeners()
    registerIPCListeners()
    await loadSettings()
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  function attachEventListeners() {
    btnMin.addEventListener('click',   () => api.minimizeWindow())
    btnClose.addEventListener('click', () => api.closeWindow())
    btnPin.addEventListener('click', async () => {
      alwaysOnTop = !alwaysOnTop
      await api.toggleAlwaysOnTop(alwaysOnTop)
      btnPin.style.opacity = alwaysOnTop ? '1' : '0.4'
      btnPin.title = alwaysOnTop ? 'Always on top (on)' : 'Always on top (off)'
    })

    btnSettings.addEventListener('click', () => showView('settings'))
    $('btn-back').addEventListener('click', () => showView('main'))

    btnCall.addEventListener('click', toggleCall)
    btnClearChat.addEventListener('click', clearChat)

    $('copy-ai').addEventListener('click', () => {
      const text = aiBody.innerText.trim()
      if (text && !text.includes('suggestions will appear')) {
        navigator.clipboard.writeText(text)
        const btn = $('copy-ai')
        btn.innerHTML = '✓ Copied!'
        btn.classList.add('copied')
        setTimeout(() => {
          btn.innerHTML = '📋 Copy'
          btn.classList.remove('copied')
        }, 2000)
      }
    })

    $('error-dismiss').addEventListener('click', hideError)

    // Settings
    $('btn-save-settings').addEventListener('click', saveSettings)
    $('reset-prompt').addEventListener('click', () => {
      $('s-system-prompt').value = getDefaultPrompt()
    })
    $('toggle-deepgram').addEventListener('click',  () => toggleKey('s-deepgram-key',  'toggle-deepgram'))
    $('toggle-sf-client-id').addEventListener('click',     () => toggleKey('s-sf-client-id',     'toggle-sf-client-id'))
    $('toggle-sf-client-secret').addEventListener('click', () => toggleKey('s-sf-client-secret', 'toggle-sf-client-secret'))
    $('toggle-sf-refresh-token').addEventListener('click', () => toggleKey('s-sf-refresh-token', 'toggle-sf-refresh-token'))
    $('toggle-anthropic').addEventListener('click', () => toggleKey('s-anthropic-key', 'toggle-anthropic'))

    $('test-deepgram').addEventListener('click', async () => {
      await runTest('test-deepgram', 'dg-test-result', () => api.testDeepgram())
    })
    $('test-salesforce').addEventListener('click', async () => {
      await runTest('test-salesforce', 'sf-test-result', () => api.testSalesforce())
    })
    $('test-anthropic').addEventListener('click', async () => {
      await runTest('test-anthropic', 'an-test-result', () => api.testAnthropic())
    })

    // Lead phone lookup
    $('btn-lookup').addEventListener('click', lookupLead)
    $('phone-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') lookupLead()
    })

    document.addEventListener('click', e => {
      const a = e.target.closest('[data-url]')
      if (a) { e.preventDefault(); api.openExternal(a.dataset.url) }
    })
  }

  // ── IPC listeners ──────────────────────────────────────────────────────────
  function registerIPCListeners() {
    api.onCallStatus(({ active, startTime }) => {
      callActive = active
      if (active) {
        callStartTime = startTime
        startTimer()
        setStatus('active', '🔴 Live')
        btnCall.className = 'btn-call active'
        callLabel.textContent = 'End Call'
        btnCall.querySelector('.call-icon').textContent = '📵'
      } else {
        stopTimer()
        setStatus('idle', 'Ready')
        btnCall.className = 'btn-call idle'
        callLabel.textContent = 'Start Call'
        btnCall.querySelector('.call-icon').textContent = '📞'
        // Finalise any remaining interim bubbles
        Object.keys(interimBubble).forEach(ch => { interimBubble[ch] = null })
      }
    })

    api.onTranscriptUpdate(({ text, isFinal, channel }) => {
      appendChatBubble(text, isFinal, channel)
    })

    api.onLLMReply(text => {
      thinking.classList.add('hidden')
      aiBody.innerHTML = ''
      const pre = document.createElement('pre')
      pre.style.cssText = 'font-family:inherit;white-space:pre-wrap;'
      pre.textContent = text
      aiBody.appendChild(pre)
    })

    api.onLLMThinking(on => thinking.classList.toggle('hidden', !on))

    api.onLLMError(msg => {
      thinking.classList.add('hidden')
      showError(msg)
    })

    api.onDeepgramStatus(status => {
      dgBadge.className = `dg-badge ${status === 'connected' ? 'connected' : ''}`
      dgBadge.title = `Deepgram: ${status}`
    })

    api.onDeepgramError(msg => {
      dgBadge.className = 'dg-badge error'
      showError(`Deepgram: ${msg}`)
    })

    api.onAudioError(msg => showError(`Audio: ${msg}`))

    api.onChatCleared(() => {
      chatWindow.innerHTML = ''
      chatWindow.appendChild(chatEmpty)
      chatEmpty.classList.remove('hidden')
      aiBody.innerHTML = '<span class="ai-placeholder">AI suggestions will appear here during the call</span>'
      interimBubble.lead  = null
      interimBubble.agent = null
    })

    api.onSFSaved(ok => { if (ok) showToast('Saved to Salesforce ✓') })

    api.onNavigate(page => { if (page === 'settings') showView('settings') })

    api.onLeadFound((data) => {
      showLeadInfo(data)
    })

    api.onLeadLookupStatus(({ status, phone, error }) => {
      const el = $('lookup-status')
      el.classList.remove('hidden', 'searching', 'found', 'not-found', 'error')
      if (status === 'searching') {
        el.className = 'lookup-status searching'
        el.textContent = `🔍 Searching for ${phone}...`
      } else if (status === 'not-found') {
        el.className = 'lookup-status not-found'
        el.textContent = `No contact found for ${phone}`
      } else if (status === 'error') {
        el.className = 'lookup-status error'
        el.textContent = `Error: ${error}`
      }
    })

    api.onVirtualSinkReady(({ sinkName }) => {
      setStatus('connecting', `Routing browser audio to ${sinkName}...`)
    })

    api.onAutoRouteResult(({ success, sinkName }) => {
      if (success) {
        setStatus('active', '🔴 Live')
      } else {
        showRoutingGuide(sinkName)
      }
    })
  }

  // ── Lead lookup ───────────────────────────────────────────────────────────
  async function lookupLead() {
    const phone = $('phone-input').value.trim()
    if (!phone) return

    const btn = $('btn-lookup')
    btn.disabled = true
    btn.textContent = '...'

    const result = await api.lookupLead(phone)

    btn.disabled = false
    btn.textContent = '🔍 Lookup'

    if (!result.success) {
      const el = $('lookup-status')
      el.className = 'lookup-status error'
      el.textContent = result.error
      el.classList.remove('hidden')
    }
  }

  function showLeadInfo(data) {
    // Show lead card
    const leadInfo = $('lead-info')
    leadInfo.classList.remove('hidden')

    // Set avatar initials
    const initials = data.name
      ? data.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
      : '?'
    $('lead-avatar').textContent = initials

    $('lead-name').textContent = data.name || 'Unknown'
    $('lead-meta').textContent = [data.title, data.company].filter(Boolean).join(' · ')

    // Update lookup status
    const el = $('lookup-status')
    el.className = 'lookup-status found'
    el.textContent = data.auto
      ? `⚡ Auto-detected: ${data.type} found from Salesforce call`
      : `✓ ${data.type} found in Salesforce`
    el.classList.remove('hidden')

    // Clear phone input
    $('phone-input').value = ''
  }

  // ── Chat bubbles ───────────────────────────────────────────────────────────
  function appendChatBubble(text, isFinal, channel) {
    // Hide empty state
    chatEmpty.classList.add('hidden')

    if (!isFinal) {
      // Update existing interim bubble or create one
      if (interimBubble[channel]) {
        interimBubble[channel].textContent = text
        chatWindow.scrollTop = chatWindow.scrollHeight
        return
      }
      const { row, bubble } = createBubble(text, channel, false)
      interimBubble[channel] = bubble
      chatWindow.appendChild(row)
    } else {
      if (interimBubble[channel]) {
        // Finalise the interim bubble
        interimBubble[channel].textContent = text
        interimBubble[channel].classList.remove('interim')
        interimBubble[channel] = null
      } else {
        const { row } = createBubble(text, channel, true)
        chatWindow.appendChild(row)
      }
    }

    chatWindow.scrollTop = chatWindow.scrollHeight
  }

  function createBubble(text, channel, isFinal) {
    const row = document.createElement('div')
    row.className = `msg-row ${channel}`

    const label = document.createElement('span')
    label.className = 'msg-label'
    label.textContent = channel === 'lead' ? '🔵 Lead' : '🟢 Agent'

    const bubble = document.createElement('div')
    bubble.className = `msg-bubble${isFinal ? '' : ' interim'}`
    bubble.textContent = text

    row.appendChild(label)
    row.appendChild(bubble)
    return { row, bubble }
  }

  // ── Call control ───────────────────────────────────────────────────────────
  async function toggleCall() {
    btnCall.disabled = true
    if (!callActive) {
      setStatus('connecting', 'Connecting...')
      const res = await api.startCall()
      if (!res.success) {
        setStatus('error', 'Error')
        showError(res.error)
        setStatus('idle', 'Ready')
      }
    } else {
      await api.stopCall()
    }
    btnCall.disabled = false
  }

  async function clearChat() {
    if (callActive) return
    await api.clearChat()
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  async function loadSettings() {
    const s = await api.getSettings()
    $('s-deepgram-key').value  = s.deepgramApiKey  || ''
    $('s-anthropic-key').value = s.anthropicApiKey || ''

    $('s-sf-url').value           = s.salesforceUrl  || ''
    $('s-sf-client-id').value     = s.sfClientId     || ''
    $('s-sf-client-secret').value = s.sfClientSecret || ''
    $('s-sf-refresh-token').value = s.sfRefreshToken || ''
    $('s-system-prompt').value = s.systemPrompt     || getDefaultPrompt()
    $('s-language').value      = s.language         || 'en-US'

    alwaysOnTop = s.alwaysOnTop !== false
    btnPin.style.opacity = alwaysOnTop ? '1' : '0.4'

    showEnvBadge('s-deepgram-key', s.deepgramApiKey)
    showEnvBadge('s-anthropic-key', s.anthropicApiKey)

    const [devices, inputDevices] = await Promise.all([
      api.getAudioDevices(),
      api.getInputDevices()
    ])

    const sel = $('s-audio-device')
    const savedDevice = s.audioDevice || 'default'
    sel.innerHTML = ''
    devices.forEach(d => {
      const opt = document.createElement('option')
      opt.value = d.id
      opt.textContent = d.name
      if (d.id === savedDevice) opt.selected = true
      sel.appendChild(opt)
    })
    if (!devices.find(d => d.id === savedDevice)) {
      const opt = document.createElement('option')
      opt.value = savedDevice
      opt.textContent = savedDevice + ' (saved)'
      opt.selected = true
      sel.insertBefore(opt, sel.firstChild)
    }

    const inSel = $('s-input-device')
    const savedInput = s.inputDevice || 'default'
    inSel.innerHTML = ''
    inputDevices.forEach(d => {
      const opt = document.createElement('option')
      opt.value = d.id
      opt.textContent = d.name
      if (d.id === savedInput) opt.selected = true
      inSel.appendChild(opt)
    })
    if (!inputDevices.find(d => d.id === savedInput)) {
      const opt = document.createElement('option')
      opt.value = savedInput
      opt.textContent = savedInput + ' (saved)'
      opt.selected = true
      inSel.insertBefore(opt, inSel.firstChild)
    }
  }

  async function saveSettings() {
    const settings = {
      deepgramApiKey:  $('s-deepgram-key').value.trim(),
      anthropicApiKey: $('s-anthropic-key').value.trim(),

      salesforceUrl:  $('s-sf-url').value.trim(),
      sfClientId:     $('s-sf-client-id').value.trim(),
      sfClientSecret: $('s-sf-client-secret').value.trim(),
      sfRefreshToken: $('s-sf-refresh-token').value.trim(),
      systemPrompt:    $('s-system-prompt').value.trim(),
      audioDevice:     $('s-audio-device').value,
      inputDevice:     $('s-input-device').value,
      language:        $('s-language').value
    }
    const res = await api.saveSettings(settings)
    if (res.success) {
      $('save-status').textContent = '✓ Saved'
      settingsLoaded = true  // keep current state — don't reload
      setTimeout(() => { $('save-status').textContent = '' }, 2500)
    }
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  let settingsLoaded = false
  function showView(name) {
    viewMain.classList.toggle('active', name === 'main')
    viewSettings.classList.toggle('active', name === 'settings')
    // Only load settings once on first open — not every time
    // This prevents the dropdown from resetting on every visit
    if (name === 'settings' && !settingsLoaded) {
      loadSettings()
      settingsLoaded = true
    }
  }

  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`
    statusText.textContent = text
  }

  function showError(msg) {
    errorText.textContent = msg
    errorBanner.classList.remove('hidden')
    const isKeyErr = msg.includes('401') || msg.includes('API key')
    if (!isKeyErr) setTimeout(hideError, 6000)
  }

  function hideError() { errorBanner.classList.add('hidden') }

  function showToast(msg) {
    const t = $('sf-toast')
    t.textContent = msg
    t.classList.remove('hidden')
    setTimeout(() => t.classList.add('hidden'), 3000)
  }

  function startTimer() {
    callTimer.classList.remove('hidden')
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - callStartTime) / 1000)
      callTimer.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`
    }, 1000)
  }

  function stopTimer() {
    clearInterval(timerInterval)
    callTimer.classList.add('hidden')
  }

  function toggleKey(inputId, btnId) {
    const input = $(inputId), btn = $(btnId)
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    btn.textContent = show ? '🙈' : '👁'
    btn.classList.toggle('active', show)
  }

  async function runTest(btnId, resultId, fn) {
    const btn = $(btnId), res = $(resultId)
    btn.disabled = true
    btn.textContent = '...'
    res.className = 'test-result'
    res.textContent = 'Testing...'
    const result = await fn()
    res.className = `test-result ${result.success ? 'ok' : 'err'}`
    res.textContent = result.success ? '✓ Connected' : `✗ ${result.error}`
    btn.disabled = false
    btn.textContent = 'Test'
  }

  function showEnvBadge(inputId, value) {
    const input = $(inputId)
    if (!input) return
    // Remove ALL existing badges under the same label — not just one
    const label = input.closest('label')
    if (label) label.querySelectorAll('.env-badge').forEach(b => b.remove())
    if (!value) return
    const badge = document.createElement('span')
    badge.className = 'env-badge'
    badge.textContent = '✓ Loaded from .env'
    const row = input.closest('.input-row') || input
    row.insertAdjacentElement('afterend', badge)
  }

  function showCopyFeedback(btn) {
    const orig = btn.textContent
    btn.textContent = '✓'
    btn.style.color = 'var(--green)'
    setTimeout(() => { btn.textContent = orig; btn.style.color = '' }, 1500)
  }

  function showRoutingGuide(sinkName) {
    document.getElementById('routing-guide')?.remove()
    const guide = document.createElement('div')
    guide.id = 'routing-guide'
    guide.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;'
    guide.innerHTML = `
      <div style="background:#1c2235;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;max-width:340px;width:100%;">
        <div style="font-size:15px;font-weight:600;margin-bottom:10px;">📢 Route browser audio</div>
        <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:14px;">Auto-routing failed. Do this once:</p>
        <ol style="font-size:13px;color:#94a3b8;line-height:2;padding-left:16px;margin-bottom:16px;">
          <li>Open terminal: <code style="background:#0f1117;padding:2px 6px;border-radius:4px;color:#818cf8;">pavucontrol</code></li>
          <li>Go to <strong style="color:#e2e8f0">Playback</strong> tab</li>
          <li>Find your browser → set output to <strong style="color:#818cf8">"SF-Voice-AI-Sink"</strong></li>
          <li>Click Done below</li>
        </ol>
        <div style="display:flex;gap:8px;">
          <button id="routing-done" style="flex:1;background:#6366f1;border:none;color:#fff;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;">Done</button>
          <button id="routing-cancel" style="background:#222840;border:1px solid rgba(255,255,255,0.1);color:#94a3b8;padding:10px 14px;border-radius:8px;cursor:pointer;">Cancel</button>
        </div>
      </div>`
    document.body.appendChild(guide)
    document.getElementById('routing-done').addEventListener('click', () => { guide.remove(); setStatus('active', '🔴 Live') })
    document.getElementById('routing-cancel').addEventListener('click', async () => { guide.remove(); await api.stopCall() })
  }

  function getDefaultPrompt() {
    return `You are an elite real-time sales coach sitting next to a sales agent during a live call. You hear everything the lead says and whisper exactly what the agent should say next — like a coach in their ear.

You receive:
- Lead profile from Salesforce (name, company, industry, title, revenue, rating, status)
- Full live conversation between Lead and Agent

HOW A REAL SALES COACH RESPONDS:
You do not label pain points. You do not explain what you are doing. You just tell the agent the exact words or move to make — naturally, conversationally, like a coach would whisper in real life.

WHEN THE LEAD IS TALKING ABOUT A PROBLEM:
Help the agent go deeper before pitching anything.
Example response: "Ask them — how long has this been going on and what have you tried so far?"

WHEN THE LEAD RAISES PRICE OR BUDGET:
Do not fight it. Help the agent understand the real constraint first.
Example response: "Say — I hear you, can I ask what kind of return would make this a no-brainer for you?"

WHEN THE LEAD MENTIONS A COMPETITOR:
Never attack. Help agent find out what matters most.
Example response: "Ask — what does [competitor] do well for you and what would you want to be different?"

WHEN THE LEAD SHOWS INTEREST:
Move forward immediately.
Example response: "Lock it in — ask: what does your calendar look like this week for a quick demo?"

WHEN THE LEAD IS HESITATING OR GOING QUIET:
Re-engage with curiosity.
Example response: "Ask an open question — what's your biggest concern about moving forward right now?"

WHEN THE LEAD IS READY TO BUY:
Give the agent a clean close.
Example response: "Close it — say: based on everything you have shared, it sounds like we are a great fit. Want to get started today?"

USE SALESFORCE DATA NATURALLY:
- If Rating is Hot: suggest moving toward a close or next step
- If Rating is Cold: focus on curiosity and discovery, not pitch
- If company is large: focus on scale, risk reduction, ROI
- If company is small: focus on speed, simplicity, quick wins
- If Lead Source is Referral: acknowledge the relationship warmth

RULES:
- Max 2-3 sentences
- Sound like a human coach whispering — not a robot reporting
- Never use labels like "Pain point:" or "Buying signal:"
- Never repeat what was just said
- Never explain what you are doing — just do it
- One clear direction at a time

If the lead has not said enough yet: respond with only "Listening..."`
  }

  document.addEventListener('DOMContentLoaded', init)
  if (document.readyState !== 'loading') init()
})()