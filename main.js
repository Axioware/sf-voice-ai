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

let isCallActive  = false
let conversation  = []        // [{ role: 'lead'|'agent', text, time }]
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
  // Debounce — wait for natural pause before calling LLM
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
    const reply = await claudeService.getSuggestion({ conversation })
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
  const config = getCurrentConfig()
  if (!config.deepgramApiKey) return { success: false, error: 'Deepgram API key not set. Go to Settings.' }

  try {
    isCallActive = true
    conversation = []

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
  Object.entries(settings).forEach(([k, v]) => store.set(k, typeof v === 'string' ? v.trim() : v))
  // Reinit only Claude/Deepgram clients with new API keys — don't reset audio device
  claudeService   = new (require('./services/claude'))(getCurrentConfig())
  deepgramService = new (require('./services/deepgram'))(getCurrentConfig())
  return { success: true }
})
ipcMain.handle('get-audio-devices', async () => audioCapture?.listDevices() || [])
ipcMain.handle('test-deepgram',    async () => {
  const key = getCurrentConfig().deepgramApiKey
  if (!key) return { success: false, error: 'No API key found' }
  return deepgramService.testConnection(key)
})
ipcMain.handle('test-anthropic',   async () => {
  const key = getCurrentConfig().anthropicApiKey
  if (!key) return { success: false, error: 'No API key found' }
  return claudeService.testConnection(key)
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
    salesforceUrl:   store.get('salesforceUrl',   ''),
    systemPrompt:    store.get('systemPrompt',    getDefaultPrompt()),
    audioDevice:     store.get('audioDevice',     'default'),
    language:        store.get('language',        'en-US'),
    alwaysOnTop:     store.get('alwaysOnTop',     true)
  }
}

function getDefaultPrompt() {
  return `You are an AI sales assistant listening to a live call between a sales agent and a lead.

You receive the full conversation transcript with two roles:
- "Lead" — the potential customer speaking through the phone/speaker
- "Agent" — the sales representative speaking into their microphone

Your job:
- Analyse the latest exchange and give the agent a SHORT, ACTIONABLE suggestion
- Identify objections, buying signals, questions, or hesitation from the lead
- Suggest exactly what the agent should say or do next
- Be concise — under 80 words, bullet points if multiple suggestions
- Never repeat the transcript back
- If not enough context yet, say "Listening..."`
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
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