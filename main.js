require('dotenv').config()

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron')
const path  = require('path')
const Store = require('electron-store')
const AudioCaptureService = require('./services/audioCapture')
const DeepgramService     = require('./services/deepgram')
const ClaudeService       = require('./services/claude')
const SalesforceService   = require('./services/salesforce')

const store = new Store()

let mainWindow  = null
let tray        = null
let audioCapture    = null
let deepgramService = null
let claudeService   = null
let salesforceService = null

let isCallActive      = false
let conversation      = []    // [{ role: 'lead'|'agent', text, time }]
let leadContext       = null  // formatted string from Salesforce lead lookup
let llmDebounceTimer  = null
const LLM_DEBOUNCE_MS = 600   // 600ms feels natural — fast but not jumpy

// ── Window ────────────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520, height: 820,
    minWidth: 440, minHeight: 600,
    frame: false, transparent: false,
    alwaysOnTop: store.get('alwaysOnTop', true),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    backgroundColor: '#0f1117'
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools({ mode: 'detach' })
  })
  mainWindow.on('closed', () => { mainWindow = null })
}


function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  const menu = Menu.buildFromTemplate([
    { label: 'Show App',  click: () => mainWindow?.show() },
    { label: 'Settings',  click: () => mainWindow?.webContents.send('navigate', 'settings') },
    { type: 'separator' },
    { label: 'Quit',      click: () => app.quit() }
  ])
  tray.setToolTip('SF Voice AI')
  tray.setContextMenu(menu)
  tray.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow.show())
}

// ── Services ──────────────────────────────────────────────────────────────────
function syncEnvToStore() {
  // .env always wins — if a key exists in .env, it overwrites whatever is in the store.
  // This means changing .env and restarting the app immediately takes effect.
  const pairs = [
    ['deepgramApiKey',  process.env.DEEPGRAM_API_KEY],
    ['anthropicApiKey', process.env.ANTHROPIC_API_KEY],
    ['salesforceUrl',   process.env.SF_INSTANCE_URL],
    ['sfClientId',      process.env.SF_CLIENT_ID],
    ['sfClientSecret',  process.env.SF_CLIENT_SECRET],
    ['sfRefreshToken',  process.env.SF_REFRESH_TOKEN],
  ]
  pairs.forEach(([key, val]) => {
    if (val && val.trim()) store.set(key, val.trim())
  })
}

function initServices() {
  const config = getCurrentConfig()
  audioCapture     = new AudioCaptureService(config)
  deepgramService  = new DeepgramService(config)
  claudeService    = new ClaudeService(config)
  salesforceService = new SalesforceService(config)

  deepgramService.on('transcript',    handleTranscript)
  deepgramService.on('utterance-end', handleUtteranceEnd)
  deepgramService.on('error',         (err) => sendToRenderer('deepgram-error', err.message))
  deepgramService.on('connected',     () => sendToRenderer('deepgram-status', 'connected'))
  deepgramService.on('disconnected',  () => sendToRenderer('deepgram-status', 'disconnected'))

  audioCapture.on('error', (err) => sendToRenderer('audio-error', err.message))
  audioCapture.on('virtual-sink-ready', async ({ sinkName }) => {
    sendToRenderer('virtual-sink-ready', { sinkName })
    const ok = await audioCapture.autoRouteBrowser()
    sendToRenderer('auto-route-result', { success: ok, sinkName })
  })
}

// ── Transcript pipeline ───────────────────────────────────────────────────────
function handleTranscript({ text, isFinal, channel }) {
  if (!text?.trim()) return

  // Send to UI for chat display
  sendToRenderer('transcript-update', { text, isFinal, channel })

  // Buffer final transcripts into conversation
  if (isFinal) {
    conversation.push({ role: channel, text: text.trim(), time: Date.now() })
    // Trim conversation to last 30 turns to avoid huge prompts
    if (conversation.length > 30) conversation = conversation.slice(-30)
  }
}

function handleUtteranceEnd({ channel }) {
  // Only trigger LLM suggestion when the LEAD finishes speaking
  // Agent utterances are added to conversation for context but don't trigger suggestions
  if (channel !== 'lead') return

  clearTimeout(llmDebounceTimer)
  llmDebounceTimer = setTimeout(async () => {
    if (conversation.length === 0) return
    await callLLM()
  }, LLM_DEBOUNCE_MS)
}

async function callLLM() {
  if (!claudeService.isConfigured()) {
    sendToRenderer('llm-error', 'Anthropic API key not configured. Go to Settings.')
    return
  }
  sendToRenderer('llm-thinking', true)
  try {
    const reply = await claudeService.getSuggestion({ conversation, leadContext })
    sendToRenderer('llm-reply', reply)
  } catch (err) {
    sendToRenderer('llm-error', err.message)
  } finally {
    sendToRenderer('llm-thinking', false)
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('start-call', async () => {
  if (isCallActive) return { success: false, error: 'Call already active' }

  // Re-init services with latest config from store before connecting
  // This ensures keys saved via Settings are always picked up
  initServices()

  const config = getCurrentConfig()

  console.log('[start-call] deepgramApiKey present:', !!config.deepgramApiKey)
  console.log('[start-call] key length:', config.deepgramApiKey?.length || 0)

  if (!config.deepgramApiKey) return { success: false, error: 'Deepgram API key not set. Go to Settings.' }

  try {
    isCallActive = true
    conversation = []
    leadContext  = null

    await deepgramService.connect(config)

    // Start both audio channels
    const { leadStream, agentStream } = await audioCapture.start(config.audioDevice)

    leadStream.on('data',  chunk => deepgramService.sendAudio(chunk, 'lead'))
    agentStream.on('data', chunk => deepgramService.sendAudio(chunk, 'agent'))

    sendToRenderer('call-status', { active: true, startTime: Date.now() })
    return { success: true }
  } catch (err) {
    isCallActive = false
    return { success: false, error: err.message }
  }
})

ipcMain.handle('stop-call', async () => {
  if (!isCallActive) return { success: false }
  isCallActive = false
  clearTimeout(llmDebounceTimer)
  await audioCapture.stop()
  await deepgramService.disconnect()
  sendToRenderer('call-status', { active: false })

  if (salesforceService.isConfigured() && conversation.length > 0) {
    const transcript = conversation.map(m => `${m.role === 'lead' ? 'Lead' : 'Agent'}: ${m.text}`).join('\n')
    try { await salesforceService.saveCallNote(transcript); sendToRenderer('sf-saved', true) }
    catch (e) { sendToRenderer('sf-saved', false) }
  }
  return { success: true }
})

ipcMain.handle('get-settings',     () => getCurrentConfig())
ipcMain.handle('save-settings',    (_, settings) => {
  // Save all settings — trim strings to remove accidental spaces/newlines from copy-paste
  Object.entries(settings).forEach(([k, v]) => {
    const val = typeof v === 'string' ? v.trim() : v
    store.set(k, val)
    console.log(`[save-settings] ${k}:`, k.includes('key') || k.includes('secret') || k.includes('token')
      ? (val ? `set (${val.length} chars)` : 'empty')
      : val)
  })
  // Reinit all services with updated config
  initServices()
  return { success: true }
})
ipcMain.handle('get-audio-devices', async () => audioCapture?.listDevices() || [])
ipcMain.handle('test-deepgram',    async () => {
  const key = getCurrentConfig().deepgramApiKey
  if (!key) return { success: false, error: 'No API key found' }
  return deepgramService.testConnection(key)
})
ipcMain.handle('test-salesforce', async () => {
  if (!salesforceService.isConfigured()) {
    return { success: false, error: 'Salesforce not configured. Fill in all SF fields in Settings.' }
  }
  return salesforceService.testConnection()
})

ipcMain.handle('test-anthropic',   async () => {
  const key = getCurrentConfig().anthropicApiKey
  if (!key) return { success: false, error: 'No API key found' }
  return claudeService.testConnection(key)
})
// Called from renderer when Salesforce CTI fires with a phone number
ipcMain.handle('lookup-lead', async (_, phoneNumber) => {
  if (!phoneNumber) return { success: false, error: 'No phone number provided' }
  if (!salesforceService.isConfigured()) {
    return { success: false, error: 'Salesforce not configured in Settings' }
  }

  try {
    sendToRenderer('lead-lookup-status', { status: 'searching', phone: phoneNumber })
    const record = await salesforceService.getLeadByPhone(phoneNumber)

    if (!record) {
      sendToRenderer('lead-lookup-status', { status: 'not-found', phone: phoneNumber })
      return { success: false, error: `No contact found for ${phoneNumber}` }
    }

    // Format and store as context for Claude
    leadContext = salesforceService.formatLeadContext(record)

    // Send lead info to UI to display
    sendToRenderer('lead-found', {
      name:     `${record.FirstName || ''} ${record.LastName || ''}`.trim(),
      company:  record.Account?.Name || record.Company || '',
      title:    record.Title || '',
      phone:    phoneNumber,
      type:     record._type
    })

    return { success: true }
  } catch (err) {
    sendToRenderer('lead-lookup-status', { status: 'error', error: err.message })
    return { success: false, error: err.message }
  }
})

// Manual phone number entry from UI
ipcMain.handle('set-phone-number', async (_, phoneNumber) => {
  return ipcMain.emit('lookup-lead', null, phoneNumber)
})

ipcMain.handle('clear-chat',       () => {
  conversation = []
  sendToRenderer('chat-cleared')
  return { success: true }
})
ipcMain.handle('toggle-always-on-top', (_, val) => {
  store.set('alwaysOnTop', val)
  mainWindow?.setAlwaysOnTop(val)
  return { success: true }
})
ipcMain.handle('minimize-window', () => mainWindow?.minimize())
ipcMain.handle('close-window',    () => mainWindow?.hide())
ipcMain.handle('open-external',   (_, url) => shell.openExternal(url))

function getCurrentConfig() {
  return {
    deepgramApiKey:  store.get('deepgramApiKey',  process.env.DEEPGRAM_API_KEY  || ''),
    anthropicApiKey: store.get('anthropicApiKey', process.env.ANTHROPIC_API_KEY || ''),
    salesforceUrl:  store.get('salesforceUrl',  process.env.SF_INSTANCE_URL  || ''),
    sfClientId:     store.get('sfClientId',     process.env.SF_CLIENT_ID     || ''),
    sfClientSecret: store.get('sfClientSecret', process.env.SF_CLIENT_SECRET || ''),
    sfRefreshToken: store.get('sfRefreshToken', process.env.SF_REFRESH_TOKEN || ''),
    systemPrompt:    store.get('systemPrompt',    getDefaultPrompt()),
    audioDevice:     store.get('audioDevice',     'default'),
    language:        store.get('language',        'en-US'),
    alwaysOnTop:     store.get('alwaysOnTop',     true)
  }
}

function getDefaultPrompt() {
  return `You are a real-time AI coach sitting beside a sales agent during a live call.

ROLES IN TRANSCRIPT:
- 🔵 Lead = potential customer (the person the agent is trying to convert)
- 🟢 Agent = sales representative (the person you are helping)

YOUR ONLY JOB:
After the lead finishes speaking, tell the agent exactly what to say or do next.

RESPONSE RULES:
- Max 60 words — the agent is reading this live, keep it short
- Lead with the single most important action first
- Use bullet points only if there are 2-3 distinct actions needed
- Never repeat what was just said
- Never explain your reasoning — just give the suggestion
- If the lead asked a direct question, give the agent the exact answer or talking point
- If the lead expressed an objection, name it and give one rebuttal
- If the lead showed buying intent, tell the agent to move toward closing

DETECT AND RESPOND TO:
- Price objection → acknowledge + pivot to value or offer payment plan
- Budget concern → ask about timeline or suggest smaller entry package
- Competitor mention → highlight unique differentiators, never badmouth
- Feature question → answer directly + connect to their specific pain point
- Hesitation/silence → suggest an open-ended question to re-engage
- Buying signal (interest, asking about next steps) → guide agent toward close
- Request for discount → hold value first, offer discount only as last resort

TONE:
Professional, confident, empathetic. The agent should sound helpful not pushy.

If transcript has less than one full sentence from the lead, respond with only:
"Listening..."`
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
// ── Single instance lock ─────────────────────────────────────────────────────
// Prevents two copies of the app running at the same time
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone tried to open a second instance — focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  syncEnvToStore()
  initServices()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', async () => {
  if (isCallActive) { await audioCapture?.stop(); await deepgramService?.disconnect() }
})