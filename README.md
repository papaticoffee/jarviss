# صوت المساعد الصوتي

صوت المساعد الصوتي هو مساعد شخصي يعمل على ويندوز ويُبنى باستخدام Electron. واجهته عربية أولاً، مع محادثات عربية وإنجليزية عبر الذكاء الاصطناعي.

## Run

1. Install Node.js 20.19+.
2. From this folder, run `npm install`.
3. Run `npm start`.

## Build a Windows desktop package

1. Run `npm install` once.
2. Run `npm run dist` to create a Windows build in the `dist/` folder.
3. The output is suitable for local packaging and installer testing. You can later replace the default app icon with a custom `icon.ico` if needed.

## Connect an AI provider

Open **إعدادات الذكاء الاصطناعي**, choose Groq, Gemini, or OpenAI, and enter an API key. Zero verifies the key before saving it. Keys can be stored encrypted with Windows safeStorage. Chat messages and voice recordings are sent to the selected provider.

## Features

- English text and voice conversations through Groq, Gemini, or OpenAI. Groq handles chat and speech transcription; the app selects an available chat model for the account and Windows speech synthesis reads Groq replies aloud locally.
- Voice recording is limited to 90 seconds per turn. Zero asks before enabling the microphone. Audio transcription and speech generation require network access and provider support; temporary Gemini transcription overloads are retried once.
- Optional Windows login startup and a local-only wake phrase. When the current Electron/Chromium runtime provides on-device speech recognition and the selected language pack, Zero can listen for "يا زيرو" without uploading ambient audio; only the question after the wake phrase is sent to the configured AI provider. There is no cloud-recognition fallback. The microphone can be paused from the top bar.
- API keys can optionally be encrypted and stored with Electron safeStorage (Windows user protection) so the configured provider remains available after restarting. Keys are never sent to the renderer or written as plaintext.
- Tasks with optional date and time reminders. Reminders use Windows notifications while Zero is running.
- Local notes and recent conversation history, saved under Electron's application data folder.
- Google web search, opening Notepad or Calculator, and creating a new file in a selected project folder. These actions require explicit confirmation. Zero does not read the selected project automatically or overwrite an existing file.

## Limitations

AI responses require a working internet connection and a valid API key. Groq offers rate-limited free API access for eligible accounts; exact limits can change and appear in the Groq console. OpenAI and Gemini usage may incur charges. Local wake-word listening depends on on-device speech recognition and language-pack support in the installed Electron/Chromium version. The current Windows runtime reports Arabic (including `ar-EG`) as unavailable, so wake-word listening cannot activate on this machine yet; Zero reports that and does not send microphone audio as a fallback. Use push-to-talk instead. Reminders are not delivered while the application is closed. Zero does not run arbitrary shell commands, silently change system settings, or claim to perform unsupported actions.
