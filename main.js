const { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

let mainWindow;
let aiConfiguration;
let workspacePath;
let microphoneAuthorized = false;
let localData = {
  tasks: [],
  notes: [],
  chatHistory: [],
  settings: {
    autoStart: true,
    alwaysListen: false,
    autoSpeak: true,
    wakePhrase: "رعد",
    voiceLanguage: "en-US"
  }
};
let dataFilePath;
let credentialsFilePath;
let credentialsSaved = false;
let credentialLoadError = "";
const reminderTimers = new Map();
const notifiedTaskReminders = new Set();
const MAX_TIMEOUT = 2_147_000_000;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

const SYSTEM_PROMPT =
  "You are رعد, a calm, highly capable voice-first personal assistant inspired by a polished Jarvis-like system. " +
  "Be clear, confident, practical, and conversational. Keep answers concise but useful. " +
  "Always reply in English, even if the user writes or speaks in another language. When speaking naturally, sound like a focused, capable digital assistant with a calm, modern, futuristic tone. " +
  "You cannot control the user's computer or access project files unless the user explicitly provides the relevant information.";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#080d17",
    title: "رعد",
    frame: false,
    titleBarStyle: "hiddenInset",
    simpleFullscreen: true,
    show: false,
    focusable: true,
    autoHideMenuBar: true,
    kiosk: false,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setFullScreen(true);
  mainWindow.setSimpleFullScreen(true);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on("did-fail-load", () => {
    if (!mainWindow) return;
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function validateLocalData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("بيانات التطبيق غير صالحة.");
  }
  const { tasks, notes, chatHistory } = value;
  const settings = value.settings || {
    autoStart: true,
    alwaysListen: false,
    autoSpeak: true,
    wakePhrase: "رعد",
    voiceLanguage: "en-US"
  };
  if (!Array.isArray(tasks) || tasks.length > 500 || !Array.isArray(notes) ||
      notes.length > 500 || !Array.isArray(chatHistory) || chatHistory.length > 40 ||
      typeof settings.autoStart !== "boolean" ||
      typeof settings.alwaysListen !== "boolean" ||
      typeof settings.autoSpeak !== "boolean" ||
      typeof settings.wakePhrase !== "string" ||
      !settings.wakePhrase.trim() ||
      settings.wakePhrase.length > 60 ||
      !["ar-EG", "en-US"].includes(settings.voiceLanguage || "en-US")) {
    throw new Error("وصلت البيانات للحد الأقصى أو بتنسيق غير صالح.");
  }

  const validText = (text, max) => typeof text === "string" && text.length <= max;
  for (const task of tasks) {
    if (!task || !validText(task.id, 100) || !validText(task.title, 200) ||
        !validText(task.details, 4000) || !validText(task.dueAt, 40) ||
        typeof task.completed !== "boolean" ||
        (task.dueAt && !Number.isFinite(Date.parse(task.dueAt)))) {
      throw new Error("إحدى المهام غير صالحة.");
    }
  }
  for (const note of notes) {
    if (!note || !validText(note.id, 100) || !validText(note.title, 200) ||
        !validText(note.content, 100_000) || !validText(note.updatedAt, 40)) {
      throw new Error("إحدى الملاحظات غير صالحة.");
    }
  }
  for (const message of chatHistory) {
    if (!message || !["user", "assistant"].includes(message.role) ||
        !validText(message.content, 12_000)) {
      throw new Error("سجل المحادثة غير صالح.");
    }
  }
  return {
    tasks,
    notes,
    chatHistory,
    settings: {
      ...settings,
      autoSpeak: typeof settings.autoSpeak === "boolean" ? settings.autoSpeak : true,
      wakePhrase: settings.wakePhrase.trim(),
      voiceLanguage: settings.voiceLanguage || "en-US"
    }
  };
}

async function loadLocalData() {
  dataFilePath = path.join(app.getPath("userData"), "zero-data.json");
  credentialsFilePath = path.join(app.getPath("userData"), "zero-credentials.json");

  const fallbackLocalData = {
    tasks: [],
    notes: [],
    chatHistory: [],
    settings: {
      autoStart: true,
      alwaysListen: false,
      autoSpeak: true,
      wakePhrase: "رعد",
      voiceLanguage: "en-US"
    }
  };

  try {
    const raw = await fs.readFile(dataFilePath, "utf8");
    localData = validateLocalData(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      localData = fallbackLocalData;
      await persistLocalData(localData);
    } else {
      console.warn("Zero local data was invalid or unreadable; resetting to defaults.", error);
      localData = fallbackLocalData;
      try {
        await persistLocalData(localData);
      } catch {
        // Ignore persistence errors here so the app can still open with a clean in-memory state.
      }
    }
  }

  try {
    await loadSavedCredentials();
  } catch (error) {
    credentialLoadError = error.message;
  }
  applyLoginItemSettings(localData.settings.autoStart);
  scheduleTaskReminders();
}

function getLoginItemOptions() {
  return { path: process.execPath, args: [app.getAppPath()] };
}

function getAutoStartEnabled() {
  const options = getLoginItemOptions();
  const settings = app.getLoginItemSettings(options);
  const item = settings.launchItems?.find((launchItem) =>
    launchItem.name === "Zero" &&
    path.resolve(launchItem.path).toLowerCase() === path.resolve(options.path).toLowerCase() &&
    launchItem.args.length === options.args.length &&
    launchItem.args.every((argument, index) => argument === options.args[index])
  );
  return item ? item.enabled : settings.openAtLogin && settings.executableWillLaunchAtLogin;
}

function applyLoginItemSettings(enabled) {
  app.setLoginItemSettings({
    ...getLoginItemOptions(),
    openAtLogin: enabled,
    enabled,
    name: "Zero"
  });
}

async function loadSavedCredentials() {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(credentialsFilePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!saved || !["openai", "gemini", "groq", "Groq"].includes(saved.provider) ||
      typeof saved.encryptedApiKey !== "string") {
    throw new Error("ملف بيانات اتصال الذكاء الاصطناعي غير صالح.");
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("تعذر الوصول إلى تشفير ويندوز الآمن لقراءة مفتاح الذكاء الاصطناعي.");
  }
  const encrypted = Buffer.from(saved.encryptedApiKey, "base64");
  if (!encrypted.length) throw new Error("مفتاح الذكاء الاصطناعي المحفوظ غير صالح.");
  const { result: apiKey } = await safeStorage.decryptStringAsync(encrypted);
  if (!apiKey.trim()) throw new Error("مفتاح الذكاء الاصطناعي المحفوظ فارغ.");
  aiConfiguration = {
    provider: saved.provider === "Groq" ? "groq" : saved.provider,
    apiKey,
    model: null
  };
  credentialsSaved = true;
}

async function saveCredentials(provider, apiKey) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("تشفير ويندوز الآمن غير متاح؛ لم يتم حفظ المفتاح.");
  }
  const encrypted = await safeStorage.encryptStringAsync(apiKey);
  const temporaryPath = `${credentialsFilePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({
    provider,
    encryptedApiKey: encrypted.toString("base64")
  }), { encoding: "utf8", flag: "w" });
  await fs.rename(temporaryPath, credentialsFilePath);
  credentialsSaved = true;
}

async function persistLocalData(data) {
  const validated = validateLocalData(data);
  const temporaryPath = `${dataFilePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(validated, null, 2), {
    encoding: "utf8",
    flag: "w"
  });
  await fs.rename(temporaryPath, dataFilePath);
  localData = validated;
  scheduleTaskReminders();
}

function scheduleTaskReminders() {
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  for (const task of localData.tasks) {
    if (task.completed || !task.dueAt || notifiedTaskReminders.has(task.id)) continue;
    const remaining = Date.parse(task.dueAt) - Date.now();
    if (remaining < -15 * 60 * 1000) continue;
    const timer = setTimeout(() => {
      if (Date.parse(task.dueAt) - Date.now() > 0) {
        scheduleTaskReminders();
        return;
      }
      if (Notification.isSupported()) {
        new Notification("تذكير من زيرو", {
          body: task.title,
          silent: false
        }).show();
      }
      notifiedTaskReminders.add(task.id);
      reminderTimers.delete(task.id);
    }, Math.max(0, Math.min(remaining, MAX_TIMEOUT)));
    reminderTimers.set(task.id, timer);
  }
}

async function checkInternetConnection() {
  const endpoints = [
    "https://www.google.com/generate_204",
    "https://api.groq.com/openai/v1/models",
    "https://generativelanguage.googleapis.com/v1beta/models"
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        cache: "no-store"
      });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Try the next endpoint if the first is unreachable.
    }
  }
  return false;
}

ipcMain.handle("network:status", async () => ({
  online: await checkInternetConnection()
}));

ipcMain.handle("data:load", () => ({
  tasks: localData.tasks,
  notes: localData.notes,
  chatHistory: localData.chatHistory,
  settings: localData.settings
}));

ipcMain.handle("data:save", async (_event, data) => {
  await persistLocalData(data);
  return { saved: true };
});

ipcMain.handle("device:get-autostart", () => ({
  enabled: getAutoStartEnabled()
}));

ipcMain.handle("device:set-autostart", async (_event, enabled) => {
  if (typeof enabled !== "boolean") {
    throw new Error("إعداد التشغيل التلقائي غير صالح.");
  }
  const previous = getAutoStartEnabled();
  applyLoginItemSettings(enabled);
  if (getAutoStartEnabled() !== enabled) {
    throw new Error("ويندوز لم يؤكد تغيير إعداد التشغيل التلقائي.");
  }
  try {
    await persistLocalData({
      ...localData,
      settings: { ...localData.settings, autoStart: enabled }
    });
  } catch (error) {
    applyLoginItemSettings(previous);
    throw error;
  }
  return { enabled: getAutoStartEnabled() };
});

ipcMain.handle("ai:status", () => ({
  configured: Boolean(aiConfiguration),
  provider: aiConfiguration?.provider || null,
  remembered: credentialsSaved,
  error: credentialLoadError
}));

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 20) {
    throw new Error("The conversation must contain between 1 and 20 messages.");
  }

  return messages.map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > 12000
    ) {
      throw new Error("A conversation message was invalid.");
    }

    return { role: message.role, content: message.content };
  });
}

async function askOpenAI(messages, apiKey) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ]
    })
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || `OpenAI returned HTTP ${response.status}.`);
  }

  const answer = result.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || answer.length === 0) {
    throw new Error("OpenAI returned an empty response.");
  }
  return answer;
}

async function askGemini(messages, apiKey) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }]
        }))
      })
    }
  );
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || `Gemini returned HTTP ${response.status}.`);
  }

  const answer = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!answer) {
    throw new Error("Gemini returned an empty response.");
  }
  return answer;
}

const GROQ_CHAT_MODEL_PREFERENCES = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
  "qwen/qwen3-32b",
  "openai/gpt-oss-20b"
];

function chooseGroqChatModel(models) {
  const ids = models
    .map((model) => model?.id)
    .filter((id) => typeof id === "string" && !/(guard|safeguard|whisper|embed|tts|speech|transcri|moderation)/i.test(id));
  const knownChatModels = ids.filter((id) =>
    /^(llama-|meta-llama\/|openai\/gpt-oss-|qwen\/|moonshotai\/|deepseek-|gemma|groq\/)/i.test(id)
  );
  return GROQ_CHAT_MODEL_PREFERENCES.find((id) => ids.includes(id)) ||
    knownChatModels[0] ||
    ids[0] ||
    null;
}

async function getGroqChatModel(apiKey) {
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    method: "GET",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `Groq returned HTTP ${response.status}.`);
  }
  const model = chooseGroqChatModel(Array.isArray(result.data) ? result.data : []);
  if (!model) {
    throw new Error("Groq accepted the API key, but this account has no available chat model.");
  }
  return model;
}

async function askGroq(messages, apiKey, model) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ]
    })
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `Groq returned HTTP ${response.status}.`);
  }
  const answer = result.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("Groq returned an empty response.");
  }
  return answer.trim();
}

function getAudioBuffer(audioData, mimeType) {
  if (
    !ArrayBuffer.isView(audioData) ||
    audioData.byteLength === 0 ||
    audioData.byteLength > 20 * 1024 * 1024 ||
    typeof mimeType !== "string" ||
    !mimeType.startsWith("audio/")
  ) {
    throw new Error("التسجيل الصوتي غير صالح أو أكبر من الحد المسموح.");
  }
  return Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength);
}

async function transcribeOpenAI(audio, mimeType, language, apiKey) {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("language", language.startsWith("en") ? "en" : "ar");
  form.append("file", new Blob([audio], { type: mimeType }), "zero-recording.webm");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `OpenAI transcription returned HTTP ${response.status}.`);
  }
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("ماقدرتش أميّز كلام في التسجيل. جرّب تتكلم أوضح واضغط الدائرة تاني.");
  }
  return result.text.trim();
}

async function transcribeGroq(audio, mimeType, language, apiKey) {
  const form = new FormData();
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", language.startsWith("en") ? "en" : "ar");
  form.append("file", new Blob([audio], { type: mimeType }), "raad-recording.webm");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `Groq transcription returned HTTP ${response.status}.`);
  }
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Groq could not recognize speech. Try speaking more clearly and record again.");
  }
  return result.text.trim();
}

async function transcribeGemini(audio, mimeType, language, apiKey) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: `Transcribe exactly the spoken words in this audio. The speaker is using ${language.startsWith("en") ? "English" : "Egyptian Arabic"}. Return only the transcript, with no commentary.` },
          { inlineData: { mimeType: mimeType.split(";")[0], data: audio.toString("base64") } }
        ]
      }]
    })
  };
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(url, { ...request, signal: AbortSignal.timeout(90000) });
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) {
      break;
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 3000)
      : 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const result = await response.json();
  if (!response.ok) {
    if ([429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error("Gemini مشغول مؤقتًا. جرّب التسجيل تاني بعد دقيقة، أو اختار Groq من الإعدادات.");
    }
    throw new Error(result.error?.message || `Gemini transcription returned HTTP ${response.status}.`);
  }
  const transcript = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!transcript) {
    throw new Error("ماقدرتش أميّز كلام في التسجيل. جرّب تتكلم أوضح واضغط الدائرة تاني.");
  }
  return transcript;
}

async function transcribeAudio(audioData, mimeType, language) {
  if (!aiConfiguration) {
    throw new Error("Open settings and connect Groq, Gemini, or OpenAI first.");
  }
  if (!["ar-EG", "en-US"].includes(language)) {
    throw new Error("لغة التعرّف على الصوت غير مدعومة.");
  }
  const audio = getAudioBuffer(audioData, mimeType);
  if (aiConfiguration.provider === "openai") {
    return transcribeOpenAI(audio, mimeType, language, aiConfiguration.apiKey);
  }
  if (aiConfiguration.provider === "groq") {
    return transcribeGroq(audio, mimeType, language, aiConfiguration.apiKey);
  }
  return transcribeGemini(audio, mimeType, language, aiConfiguration.apiKey);
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesizeSpeechOpenAI(text, apiKey, language = "en-US") {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "onyx",
      response_format: "mp3",
      instructions: language.startsWith("ar")
        ? "Speak in calm Egyptian Arabic, clear and natural, with a polished futuristic assistant tone."
        : "Speak in calm, confident natural English, with a polished futuristic assistant tone.",
      input: text
    })
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error?.message || `OpenAI speech returned HTTP ${response.status}.`);
  }
  return { audio: Buffer.from(await response.arrayBuffer()), mimeType: "audio/mpeg" };
}

async function synthesizeSpeechGemini(text, apiKey, language = "en-US") {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-preview-tts:generateContent",
    {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Speak in a calm, confident, modern Jarvis-like voice. ${language.startsWith("ar") ? "Use Egyptian Arabic." : "Use natural English."} Keep the phrasing polished and concise: ${text}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Kore" }
            }
          }
        }
      })
    }
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `Gemini speech returned HTTP ${response.status}.`);
  }
  const audioPart = result.candidates?.[0]?.content?.parts
    ?.find((part) => part.inlineData?.data || part.inline_data?.data);
  const data = audioPart?.inlineData?.data || audioPart?.inline_data?.data;
  const mimeType = audioPart?.inlineData?.mimeType || audioPart?.inline_data?.mime_type || "";
  if (!data || !mimeType.startsWith("audio/")) {
    throw new Error("Gemini ما رجعش صوت. اتأكد إن الموديل متاح لحسابك.");
  }

  const audio = Buffer.from(data, "base64");
  if (mimeType.startsWith("audio/L16") || mimeType.startsWith("audio/pcm")) {
    const sampleRate = Number(mimeType.match(/rate=(\d+)/)?.[1]) || 24000;
    return { audio: pcmToWav(audio, sampleRate), mimeType: "audio/wav" };
  }
  return { audio, mimeType };
}

ipcMain.handle("ai:transcribe", async (_event, audioData, mimeType, language) =>
  transcribeAudio(audioData, mimeType, language)
);

async function speakWithSystemVoice(text, language = "en-US") {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("نص الكلام غير صالح.");
  }

  const normalized = text.trim();
  const speechLanguage = ["ar-EG", "ar", "ar-SA"].includes(language) ? "ar-EG" : "en-US";
  const escaped = normalized.replace(/'/g, "''");
  const script = `
    $voice = New-Object -ComObject SAPI.SpVoice;
    $voice.Rate = ${speechLanguage === "ar-EG" ? -1 : 0};
    $voice.Volume = 100;
    $voices = $voice.GetVoices();
    if ('${speechLanguage}' -match 'ar') {
      $match = $voices | Where-Object { $_.Language -match 'AR' } | Select-Object -First 1;
      if ($match) { $voice.Voice = $match; }
    }
    $voice.Speak('${escaped}');
  `;

  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Windows TTS exited with code ${code}.`)));
  });

  return { ok: true, provider: "system" };
}

ipcMain.handle("device:speak-system", async (_event, text, language = "en-US") =>
  speakWithSystemVoice(text, language)
);

async function verifyProviderCredentials(provider, apiKey) {
  const url = provider === "openai"
    ? "https://api.openai.com/v1/models"
    : provider === "groq"
      ? "https://api.groq.com/openai/v1/models"
    : "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash";
  const headers = provider === "openai" || provider === "groq"
    ? { Authorization: `Bearer ${apiKey}` }
    : { "x-goog-api-key": apiKey };
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15000),
    headers,
    cache: "no-store"
  });
  if (!response.ok) {
    let detail = "";
    try {
      const result = await response.json();
      detail = result.error?.message || "";
    } catch {
      // Use the HTTP status when the provider did not return JSON.
    }
    const providerName = provider === "openai" ? "OpenAI" : provider === "gemini" ? "Gemini" : "Groq";
    throw new Error(detail || `${providerName} rejected the API key (HTTP ${response.status}).`);
  }
  if (provider === "groq") {
    const result = await response.json();
    const model = chooseGroqChatModel(Array.isArray(result.data) ? result.data : []);
    if (!model) {
      throw new Error("Groq accepted the API key, but this account has no available chat model.");
    }
    return model;
  }
  return null;
}

ipcMain.handle("ai:speak", async (_event, text, language = "en-US") => {
  if (typeof text !== "string" || !text.trim() || text.length > 12000) {
    throw new Error("نص الرد الصوتي غير صالح.");
  }

  if (!aiConfiguration || aiConfiguration.provider === "groq") {
    return speakWithSystemVoice(text.trim(), language);
  }

  try {
    const speechLanguage = ["ar-EG", "ar", "ar-SA"].includes(language) ? "ar-EG" : "en-US";
    const result = aiConfiguration.provider === "openai"
      ? await synthesizeSpeechOpenAI(text.trim(), aiConfiguration.apiKey, speechLanguage)
      : await synthesizeSpeechGemini(text.trim(), aiConfiguration.apiKey, speechLanguage);
    return { audio: result.audio.toString("base64"), mimeType: result.mimeType, provider: aiConfiguration.provider };
  } catch (error) {
    console.warn("AI speech generation failed; the renderer will try local speech.", error);
    throw error;
  }
});

function confirmAction(title, message, buttonLabel) {
  return dialog.showMessageBox(mainWindow, {
    type: "warning",
    title,
    message,
    buttons: ["إلغاء", buttonLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
}

ipcMain.handle("ai:configure", async (_event, configuration) => {
  if (
    !configuration ||
    !["openai", "gemini", "groq"].includes(configuration.provider) ||
    typeof configuration.apiKey !== "string" ||
    configuration.apiKey.length > 500 ||
    typeof configuration.rememberKey !== "boolean"
  ) {
    throw new Error("اختار مزوّدًا وأدخل مفتاح API صالحًا.");
  }

  const apiKey = configuration.apiKey.trim() ||
    (aiConfiguration?.provider === configuration.provider ? aiConfiguration.apiKey : "");
  if (apiKey.length < 10) {
    throw new Error("أدخل مفتاح API صالحًا للمزوّد المختار.");
  }
  const model = await verifyProviderCredentials(configuration.provider, apiKey);
  if (configuration.rememberKey) {
    await saveCredentials(configuration.provider, apiKey);
  } else {
    await fs.rm(credentialsFilePath, { force: true });
    credentialsSaved = false;
  }
  aiConfiguration = {
    provider: configuration.provider,
    apiKey,
    model
  };
  credentialLoadError = "";
  return { provider: aiConfiguration.provider, remembered: configuration.rememberKey };
});

ipcMain.handle("ai:chat", async (_event, incomingMessages) => {
  if (!aiConfiguration) {
    throw new Error("Open settings and connect Groq, Gemini, or OpenAI first.");
  }

  const messages = validateMessages(incomingMessages);
  if (aiConfiguration.provider === "openai") {
    return askOpenAI(messages, aiConfiguration.apiKey);
  }
  if (aiConfiguration.provider === "groq") {
    aiConfiguration.model ||= await getGroqChatModel(aiConfiguration.apiKey);
    return askGroq(messages, aiConfiguration.apiKey, aiConfiguration.model);
  }
  return askGemini(messages, aiConfiguration.apiKey);
});

ipcMain.handle("device:request-microphone", async () => {
  if (microphoneAuthorized) return true;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "إذن استخدام الميكروفون",
    message: "هل تسمح لزيرو باستخدام الميكروفون للمحادثة الصوتية؟",
    detail: "التسجيل الصوتي يُرسل لمزوّد الذكاء الاصطناعي الذي اخترته لتحويله إلى نص، وقد تُحسب تكلفة حسب حسابك.",
    buttons: ["مش دلوقتي", "السماح"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  microphoneAuthorized = response === 1;
  return microphoneAuthorized;
});

ipcMain.handle("device:open-app", async (_event, appId) => {
  const applications = {
    notepad: { command: "notepad.exe", label: "المفكرة (Notepad)" },
    calculator: { command: "calc.exe", label: "الآلة الحاسبة (Calculator)" }
  };
  const selectedApp = applications[appId];
  if (!selectedApp) {
    throw new Error("هذا التطبيق غير موجود ضمن التطبيقات المسموح بفتحها.");
  }

  const { response } = await confirmAction(
    "تأكيد فتح تطبيق",
    `هل تسمح لزيرو بفتح ${selectedApp.label}؟`,
    "فتح التطبيق"
  );
  if (response !== 1) return { cancelled: true };

  await new Promise((resolve, reject) => {
    const child = spawn(selectedApp.command, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

  return { cancelled: false };
});

ipcMain.handle("device:search-web", async (_event, query) => {
  if (typeof query !== "string" || !query.trim() || query.length > 500) {
    throw new Error("اكتب عبارة بحث صحيحة.");
  }

  const { response } = await confirmAction(
    "تأكيد البحث على الويب",
    `هيتم فتح بحث Google عن:\n${query.trim()}`,
    "فتح البحث"
  );
  if (response !== 1) return { cancelled: true };

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
  await shell.openExternal(searchUrl);
  return { cancelled: false };
});

ipcMain.handle("workspace:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "اختار مجلد المشروع",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { cancelled: true };
  }

  workspacePath = result.filePaths[0];
  return {
    cancelled: false,
    name: path.basename(workspacePath),
    path: workspacePath
  };
});

ipcMain.handle("workspace:create-file", async (_event, input) => {
  if (!workspacePath) {
    throw new Error("اختار مجلد مشروع الأول.");
  }
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(input.name) ||
    input.name === "." ||
    input.name === ".." ||
    typeof input.content !== "string" ||
    input.content.length > 1_000_000
  ) {
    throw new Error("اسم الملف أو محتواه غير صالح (الحد الأقصى للمحتوى 1 ميجابايت).");
  }

  const fileName = input.name.trim();
  const { response } = await confirmAction(
    "تأكيد إنشاء ملف",
    `سيُنشأ الملف "${fileName}" داخل:\n${workspacePath}\nلن يستبدل زيرو أي ملف موجود.`,
    "إنشاء الملف"
  );
  if (response !== 1) return { cancelled: true };

  const destination = path.join(workspacePath, fileName);
  try {
    await fs.writeFile(destination, input.content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("الملف موجود بالفعل؛ لم يتم استبداله.");
    }
    throw error;
  }
  return { cancelled: false, name: fileName };
});

app.whenReady().then(async () => {
  try {
    await loadLocalData();
  } catch (error) {
    console.error("Unable to initialize Zero data", error);
    const message = error?.message || "Please retry after closing the app and deleting the invalid local data file.";
    dialog.showErrorBox("تعذر تحميل بيانات Zero", message);
    localData = {
      tasks: [],
      notes: [],
      chatHistory: [],
      settings: {
        autoStart: true,
        alwaysListen: false,
        autoSpeak: true,
        wakePhrase: "Zero",
        voiceLanguage: "en-US"
      }
    };
    try {
      await persistLocalData(localData);
    } catch {
      // Let the app continue with a clean default state instead of closing entirely.
    }
  }
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permission === "media" &&
    webContents === mainWindow?.webContents &&
    microphoneAuthorized
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      permission === "media" &&
      webContents === mainWindow?.webContents &&
      microphoneAuthorized
    );
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
