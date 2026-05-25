# SF Voice AI — Electron Desktop App

Real-time voice AI assistant for Salesforce calls.  
Captures call audio → Deepgram STT → Claude LLM → displays agent suggestions live.

---

## Architecture

```
Salesforce Call Audio
        │
        ▼
  Audio Capture          (node-record-lpcm16 + SoX / loopback device)
        │
        ▼
  Deepgram STT           (nova-2 model, streaming WebSocket, ~300ms latency)
        │
        ▼
  Claude LLM             (claude-sonnet-4, custom sales prompt)
        │
        ▼
  Electron UI            (transcript + AI suggestion panel, always-on-top)
        │
        ▼
  Salesforce Write-back  (saves call notes as Task via REST API — optional)
```

---

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js 18+ | https://nodejs.org |
| SoX (audio) | `brew install sox` (Mac) · `apt install sox` (Linux) · https://sox.sourceforge.net (Win) |
| Deepgram account | https://console.deepgram.com — free tier available |
| Anthropic account | https://console.anthropic.com |

**For capturing the other side of the call (not just your mic):**
- Windows: Install [ffmpeg](https://ffmpeg.org/download.html) — WASAPI loopback capture is built into Windows 10/11, no VB-Cable needed
- macOS: Install [ffmpeg](https://ffmpeg.org/download.html) (`brew install ffmpeg`) + optionally [BlackHole](https://github.com/ExistentialAudio/BlackHole) for system-audio loopback
- Linux: `parec` via `sudo apt install pulseaudio-utils` (uses PulseAudio monitor sources automatically)

---

## Quick Start

```bash
# 1. Clone / download the project
cd sf-voice-ai

# 2. Install dependencies
npm install

# 3. Set your API keys (or enter them in the app Settings panel)
cp .env.example .env
# Edit .env and fill in DEEPGRAM_API_KEY and ANTHROPIC_API_KEY

# 4. Run the app
npm start

# Development mode (with DevTools)
npm run dev
```

---

## Configuration

All settings are stored locally via `electron-store` (no cloud sync).  
Open **Settings** (⚙ icon) in the app to configure:

| Setting | Description |
|---------|-------------|
| Deepgram API Key | Required for speech-to-text |
| Anthropic API Key | Required for Claude AI suggestions |
| Audio Device | Select your mic or loopback device |
| Language | Transcription language (default: en-US) |
| Salesforce URL | Optional — for saving call notes |
| System Prompt | Customize Claude's behaviour |

---

## Folder Structure

```
sf-voice-ai/
├ main.js                  # Electron main process — orchestrates everything
├ preload.js               # Secure IPC bridge (contextBridge)
├ services/
│   ├ audioCapture.js      # Microphone / loopback audio stream
│   ├ deepgram.js          # Deepgram WebSocket STT client
│   ├ claude.js            # Anthropic Claude LLM client
│   └ salesforce.js        # Salesforce REST API (optional)
├ renderer/
│   ├ index.html           # Main UI
│   ├ css/
│   │   └ styles.css       # Dark-mode styles
│   └ js/
│       └ app.js           # Renderer logic (IPC, UI updates)
├ assets/                  # App icons
├ .env.example             # Environment variable template
├ package.json
└ README.md
```

---

## How It Works

1. **Start Call** button opens a Deepgram WebSocket connection and starts audio capture
2. Audio chunks (16kHz PCM) stream to Deepgram via WebSocket in real time
3. Deepgram returns interim (partial) and final transcripts with speaker diarization
4. After each sentence (1.2s silence debounce), the transcript is sent to Claude
5. Claude returns a short, actionable suggestion (< 80 words)
6. The suggestion appears in the UI for the agent to read
7. On **End Call**, the full transcript is optionally saved to Salesforce as a Task

---

## Salesforce Integration

### Open CTI (call events)
The app can embed the Salesforce softphone via a `BrowserView`. To enable:
1. Add your Salesforce org URL in Settings
2. Salesforce Open CTI JS events fire when calls start/end

### REST API (write-back)
To save call notes automatically:
1. Create a Connected App in Salesforce Setup
2. Enable OAuth, add the `api` scope
3. Enter Client ID, Client Secret, Username, Password+SecurityToken in Settings

---

## Customising the AI Prompt

Edit the **System Prompt** in Settings to change how Claude behaves.  
Example prompts:

**Support agent:**
```
You are helping a customer support agent. 
Identify the customer's issue and suggest the most likely solution.
Keep replies under 60 words and always include a next step.
```

**SDR / outbound sales:**
```
You are helping an SDR on a cold call.
Listen for buying signals and objections.
Suggest a discovery question or value proposition to advance the conversation.
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `SoX not found` | Install SoX for your platform (see Prerequisites) |
| No audio input | Check System Preferences > Privacy > Microphone |
| Deepgram timeout | Check your API key and network connection |
| Only hearing yourself (not caller) | Windows: ensure ffmpeg is installed — WASAPI loopback captures caller audio automatically. macOS: install BlackHole and select it in Settings. |
| Anthropic 401 error | Check your ANTHROPIC_API_KEY in Settings |

---

## Building for Distribution

```bash
npm run build
# Output in dist/ folder
```