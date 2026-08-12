# SF Voice AI

Real-time AI sales assistant for Salesforce calls.
Captures call audio → Deepgram STT → (optional) Salesforce lead lookup → Claude AI → live suggestions for the agent.

An Electron desktop app: a small always-on-top window that sits beside your softphone, transcribes both sides of the call live, pulls up whatever Salesforce already knows about the person on the phone, and feeds all of it to Claude so the agent gets a next-best-action suggestion after every sentence the lead speaks.

**This branch (`windows-support`) is the Windows-focused line of work.** It carries everything on `main` plus a set of latency and usability fixes aimed specifically at Windows deployments — see [Branch-specific improvements](#branch-specific-improvements-vs-main) below.

---

## How it works

```
Lead speaks (through speaker/headset)        Agent enters lead's phone number
        ↓                                              ↓
Audio captured via FFmpeg                     Salesforce lookup (Lead → Opportunity → Contact)
        ↓                                              ↓
Deepgram transcribes in real time (~300ms)    Record formatted into context block
        ↓                                              ↓
        └──────────────────────┬───────────────────────┘
                                ↓
              Claude AI generates a suggestion after each lead sentence
              (transcript + Salesforce context in the prompt)
                                ↓
                 Agent sees the suggestion in the UI instantly
```

Both channels — lead (speaker/call audio) and agent (microphone) — are captured and transcribed independently, then merged into one running conversation. Claude fires as soon as Deepgram reports `speech_final` for the **lead** channel, debounced 150ms, so the agent isn't interrupted mid-sentence but also doesn't wait around.

---

## Salesforce lead lookup

The app can look up the person on the call by phone number and hand whatever it finds to Claude as context, so suggestions are grounded in real CRM data (company, title, deal stage, lead rating, past notes, etc.) instead of the transcript alone.

**Flow:**
1. The agent types the lead's phone number into the input at the top of the chat window and clicks **Lookup**.
2. [services/salesforce.js](services/salesforce.js) authenticates to Salesforce using an OAuth 2.0 refresh-token flow (no interactive login — the token is minted once via a Connected App and reused/refreshed automatically).
3. It normalizes the number into the phone formats Salesforce commonly stores (`3105614025`, `+13105614025`, `(310) 561-4025`, `310-561-4025`, etc.) and searches, in order:
   - **Lead** (`Phone`)
   - **Opportunity** (via `Account.Phone` / `Account.PersonMobilePhone` / `Account.PersonHomePhone`)
   - **Contact** (`Phone` / `MobilePhone` / `HomePhone`)
   - The first match wins.
4. The matched record (name, company, industry, revenue, employee count, title, email, lead source/status/rating, owner, opportunity stage/amount, notes, last activity) is formatted into a `## Lead Information (from Salesforce)` block and shown in the UI's lead info bar.
5. That block is kept in memory for the rest of the call and prepended to **every** Claude request for the remainder of the call, alongside the live transcript. On this branch, the default system prompt ([services/claude.js](services/claude.js)) explicitly reasons about the Salesforce `Rating` (Hot → push toward a close, Cold → focus on discovery) and company size when shaping suggestions.

This is entirely optional — if the Salesforce fields in Settings (or `.env`) are left blank, the app just skips straight to transcript-only suggestions.

### Salesforce Connected App setup

You need a Salesforce **Connected App** configured for the OAuth 2.0 refresh token flow:

1. Setup → App Manager → New Connected App.
2. Enable OAuth Settings, add a callback URL (any valid URL — it isn't used by this flow), and select scopes: `api`, `refresh_token, offline_access`.
3. Save, then note the **Consumer Key** (`SF_CLIENT_ID`) and **Consumer Secret** (`SF_CLIENT_SECRET`).
4. Obtain a **refresh token** (`SF_REFRESH_TOKEN`) once via the standard OAuth 2.0 web-server or username-password flow for that Connected App.
5. Enter all four values (Instance URL, Client ID, Client Secret, Refresh Token) in the app's **Settings → Salesforce — Lead Lookup** section, or set them in `.env` (see below).

---

## Branch-specific improvements vs `main`

This branch's `services/audioCapture.js`, `services/deepgram.js`, `services/claude.js`, and `main.js` have diverged from `main` (both trace back to the same `.deb`/salesforce-lookup commit, then went separate ways). What's different here:

- **Separate Agent microphone selector.** Settings now has two independent device dropdowns: **Lead Audio Device** (call audio — VB-Cable output on Windows) and **Agent Audio Device** (your mic). Previously the agent mic was always auto-detected, which is unreliable on Windows machines with multiple audio devices. Backed by `listInputDevices()` / IPC channel `get-input-devices`, stored as the `inputDevice` setting.
- **Lower suggestion latency.** Deepgram `endpointing` 600ms → 300ms and `utterance_end_ms` 1500ms → 1000ms; the LLM debounce dropped 600ms → 150ms; the separate (and redundant) `UtteranceEnd` event no longer re-triggers a suggestion, only `speech_final` does. A new suggestion request now aborts any suggestion still in flight (`AbortController` in `main.js`/`claude.js`) so a stale reply can never overwrite a fresher one.
- **Rewritten default AI prompt.** Suggestions read like a human coach whispering a line ("Ask them — how long has this been going on?") instead of labeled bullet points, and explicitly adapt to Salesforce `Rating`, company size, and lead source.
- **Resizable AI suggestion panel** — drag the handle above "✦ AI Suggestion" to resize it; the height is remembered between sessions (`localStorage`).
- **More prominent Copy / Clear buttons** in the call view (were small icon-only buttons, now labeled).

These are not yet on `main` — if you need the Windows mic-selection or latency fixes on a `main`-based build, they'll need to be ported/merged over.

---

## Supported platforms

| Platform | Status | Audio tool needed |
|----------|--------|------------------|
| Linux (Ubuntu) | ✓ Tested | PulseAudio (built-in) — FFmpeg captures via `-f pulse` |
| Windows 10/11  | ✓ Supported | [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free) — FFmpeg captures via `-f dshow` |
| macOS          | ✓ Supported | [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free) — FFmpeg captures via `-f avfoundation` |

FFmpeg itself is required on every platform — it's the only audio engine the app uses (see [requirements.txt](requirements.txt)).

Salesforce org + Connected App is *optional*, only needed for the lead-lookup feature above.

---

## Quick start

### Linux
```bash
sudo apt install ffmpeg
npm install
npm start
```

### Windows
See [WINDOWS_SETUP.md](WINDOWS_SETUP.md) for the full walkthrough (including a quick non-technical path with screenshots).
```cmd
npm install
npm start
```

### Mac
```bash
brew install ffmpeg
# Install BlackHole: https://github.com/ExistentialAudio/BlackHole
npm install
npm start
```

---

## API Keys / config required

| Key | Required? | Get from |
|-----|-----------|----------|
| `DEEPGRAM_API_KEY` | Yes | console.deepgram.com |
| `ANTHROPIC_API_KEY` | Yes | console.anthropic.com |
| `SF_INSTANCE_URL` | Optional — enables lead lookup | Your Salesforce org, e.g. `https://yourorg.my.salesforce.com` |
| `SF_CLIENT_ID` | Optional — enables lead lookup | Salesforce Connected App "Consumer Key" |
| `SF_CLIENT_SECRET` | Optional — enables lead lookup | Salesforce Connected App "Consumer Secret" |
| `SF_REFRESH_TOKEN` | Optional — enables lead lookup | OAuth 2.0 refresh token for that Connected App |

Add these to a `.env` file (copy from `.env.example`) or enter them in the app's **Settings** screen — Settings always takes precedence over `.env` once a value has been saved there once (see `syncEnvToStore()` in [main.js](main.js)).

---

## Testing without a live call

[scripts/](scripts/) has a small toolkit for exercising the whole pipeline (audio capture → Deepgram → Claude) on Linux without needing a real phone call:

```bash
./scripts/setup-virtual-mics.sh      # creates virtual_mic + virtual_lead PulseAudio sinks
./scripts/generate-test-audio.sh     # generates sample agent/lead WAV files via espeak TTS
./scripts/run-test-call.sh           # plays them through the virtual sinks to simulate a call
./scripts/cleanup-virtual-mics.sh    # tears the virtual sinks back down
```

In the app, select **Settings → Lead Audio Device → `virtual_lead.monitor`**, start a call, then run `run-test-call.sh`.

---

## Build installers

```bash
npm run build:linux   # .deb + AppImage
npm run build:win     # .exe installer + portable (run on Windows)
npm run build:mac     # .dmg (run on Mac)
npm run build:all     # all three platforms
```

Output goes to `dist/`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | Install FFmpeg for your platform (see Supported platforms) and confirm it's on PATH |
| No audio input | Check System Preferences > Privacy > Microphone |
| Deepgram timeout | Check your API key and network connection |
| Only hearing yourself (not caller) | Install BlackHole/VB-Cable/PulseAudio monitor and select it as the Lead Audio Device |
| Wrong mic picked up as Agent voice | Set it explicitly in Settings → **Agent Audio Device** instead of relying on auto-detect |
| Anthropic 401 error | Check your `ANTHROPIC_API_KEY` in Settings |
| "No contact found for `<number>`" | The number doesn't match any Lead/Opportunity/Contact phone field in Salesforce — try a different format, or confirm the record exists |
| Salesforce test connection fails | Re-check Instance URL, Client ID/Secret, and Refresh Token — a Connected App scope missing `refresh_token, offline_access` is the most common cause |

---

## Project structure

```
sf-voice-ai/
├── main.js              # Electron main process
├── preload.js           # IPC bridge
├── services/
│   ├── audioCapture.js  # FFmpeg audio capture, per-platform device listing (all platforms)
│   ├── deepgram.js      # Speech-to-text
│   ├── claude.js        # LLM suggestions
│   └── salesforce.js    # Lead lookup by phone (OAuth refresh-token flow)
├── renderer/
│   ├── index.html       # UI (incl. resizable AI panel)
│   ├── css/styles.css
│   └── js/app.js
├── scripts/              # Linux virtual-mic test toolkit
├── WINDOWS_SETUP.md
└── .env.example
```
