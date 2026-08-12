# SF Voice AI

Real-time AI sales assistant for Salesforce calls.
Captures call audio → Deepgram STT → (optional) Salesforce lead lookup → Claude AI → live suggestions for the agent.

An Electron desktop app: a small always-on-top window that sits beside your softphone, transcribes both sides of the call live, pulls up whatever Salesforce already knows about the person on the phone, and feeds all of it to Claude so the agent gets a next-best-action suggestion after every sentence the lead speaks.

---

## How it works

```
Lead speaks (through speaker/headset)        Agent enters/detects lead's phone number
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

Both channels — lead (speaker/call audio) and agent (microphone) — are captured and transcribed independently, then merged into one running conversation. Claude only fires after the **lead** finishes a sentence (via Deepgram's utterance-end/speech-final event, debounced 600ms), so the agent isn't interrupted mid-sentence.

---

## Salesforce lead lookup

The app can look up the person on the call by phone number and hand whatever it finds to Claude as context, so suggestions are grounded in real CRM data (company, title, deal stage, past notes, lead status, etc.) instead of the transcript alone.

**Flow:**
1. The agent types the lead's phone number into the input at the top of the chat window and clicks **Lookup** (there's also a `set-phone-number` IPC hook intended for a future CTI screen-pop integration that would trigger this automatically — it isn't wired up yet, so manual entry is currently the only way to trigger a lookup).
2. [services/salesforce.js](services/salesforce.js) authenticates to Salesforce using an OAuth 2.0 refresh-token flow (no interactive login — the token is minted once via a Connected App and reused/refreshed automatically).
3. It normalizes the number into the phone formats Salesforce commonly stores (`3105614025`, `+13105614025`, `(310) 561-4025`, `310-561-4025`, etc.) and searches, in order:
   - **Lead** (`Phone`)
   - **Opportunity** (via `Account.Phone` / `Account.PersonMobilePhone` / `Account.PersonHomePhone`)
   - **Contact** (`Phone` / `MobilePhone` / `HomePhone`)
   - The first match wins.
4. The matched record (name, company, industry, revenue, employee count, title, email, lead source/status/rating, owner, opportunity stage/amount, notes, last activity) is formatted into a `## Lead Information (from Salesforce)` block and shown in the UI's lead info bar.
5. That block is kept in memory for the rest of the call and prepended to **every** Claude request for the remainder of the call, alongside the live transcript — so "what should I say next" suggestions can reference the lead's company, industry, or deal stage without the agent typing anything.

This is entirely optional — if the Salesforce fields in Settings (or `.env`) are left blank, the app just skips straight to transcript-only suggestions.

### Salesforce Connected App setup

You need a Salesforce **Connected App** configured for the OAuth 2.0 refresh token flow:

1. Setup → App Manager → New Connected App.
2. Enable OAuth Settings, add a callback URL (any valid URL — it isn't used by this flow), and select scopes: `api`, `refresh_token, offline_access`.
3. Save, then note the **Consumer Key** (`SF_CLIENT_ID`) and **Consumer Secret** (`SF_CLIENT_SECRET`).
4. Obtain a **refresh token** (`SF_REFRESH_TOKEN`) once via the standard OAuth 2.0 web-server or username-password flow for that Connected App — any standard Salesforce OAuth tutorial covers this step.
5. Enter all four values (Instance URL, Client ID, Client Secret, Refresh Token) in the app's **Settings → Salesforce — Lead Lookup** section, or set them in `.env` (see below).

---

## Supported platforms

| Tool | Install |
|------|---------|
| Node.js 18+ | https://nodejs.org |
| FFmpeg (audio capture) | `apt install ffmpeg` (Linux) · `brew install ffmpeg` (Mac) · `winget install ffmpeg` (Win) |
| Deepgram account | https://console.deepgram.com — free tier available |
| Anthropic account | https://console.anthropic.com |
| Salesforce org + Connected App | *optional* — only needed for the lead-lookup feature above |

**For capturing the other side of the call (not just your mic):**
- macOS: Install [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free virtual audio device)
- Windows: Install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free)
- Linux: Use the PulseAudio monitor of your default sink (auto-detected — see [scripts/](scripts/) for a virtual-mic test setup that doesn't need a real call)

---

## Quick start

### Linux
```bash
sudo apt install ffmpeg
npm install
npm start
```

### Windows
See [WINDOWS_SETUP.md](WINDOWS_SETUP.md)
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

[scripts/](scripts/) has a small toolkit for exercising the whole pipeline (audio capture → Deepgram → Claude) without needing a real phone call:

```bash
./scripts/setup-virtual-mics.sh      # creates virtual_mic + virtual_lead PulseAudio sinks (Linux)
./scripts/generate-test-audio.sh     # generates sample agent/lead WAV files via espeak TTS
./scripts/run-test-call.sh           # plays them through the virtual sinks to simulate a call
./scripts/cleanup-virtual-mics.sh    # tears the virtual sinks back down
```

In the app, select **Settings → Audio Device → `virtual_lead.monitor`**, start a call, then run `run-test-call.sh`.

---

## Build installers

```bash
npm run build       # Linux: .deb + AppImage
npm run build:win   # Windows: NSIS installer + portable .exe (run on Windows)
npm run build:mac   # Mac: .dmg (run on Mac)
npm run build:all   # all three platforms
```

Output goes to `dist/`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | Install FFmpeg for your platform (see Supported platforms) and confirm it's on PATH |
| No audio input | Check System Preferences > Privacy > Microphone |
| Deepgram timeout | Check your API key and network connection |
| Only hearing yourself (not caller) | Install BlackHole/VB-Cable/PulseAudio monitor and select it as the audio device |
| Anthropic 401 error | Check your `ANTHROPIC_API_KEY` in Settings |
| "No contact found for `<number>`" | The number doesn't match any Lead/Opportunity/Contact phone field in Salesforce — try the number in a different format, or confirm the record exists |
| Salesforce test connection fails | Re-check Instance URL, Client ID/Secret, and Refresh Token — a Connected App scope missing `refresh_token, offline_access` is the most common cause |