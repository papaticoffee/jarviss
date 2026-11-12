const toastElement = document.getElementById("toast");
const settingsModal = document.getElementById("settings-modal");
const orb = document.getElementById("orb-wrap");
const voiceToggle = document.getElementById("voice-toggle");
const voiceCaption = document.getElementById("voice-caption");
const transcriptElement = document.getElementById("voice-transcript");
const responseElement = document.getElementById("voice-response");
const ASSISTANT_NAME = "رعد";
const ASSISTANT_WAKE_WORD = "رعد";
const providerName = (provider) =>
  ({ openai: "OpenAI", gemini: "Gemini", groq: "Groq" })[provider] || "AI provider";

let chatHistory = [];
let appData = {
  tasks: [],
  notes: [],
  chatHistory: [],
  settings: { autoStart: true, alwaysListen: false, autoSpeak: true, wakePhrase: ASSISTANT_WAKE_WORD, voiceLanguage: "en-US" }
};
let selectedNoteId;

let aiConfigured = false;
let configuredProvider = null;
let voiceSessionActive = false;
let isRecording = false;
let isSending = false;
let voiceLanguage = "en-US";
let mediaStream;
let mediaRecorder;
let recordingChunks = [];
let stopRecordingTimer;
let activeAudio;
let toastTimeout;
let wakeRecognition;
let wakeRestartTimer;
let wakeEndWaiter;
let wakeListenerActive = false;
let wakeRecognitionStarted = false;
let wakeManuallyPaused = false;
let wakeConversation = false;
let microphonePermissionReady = false;
let speechInitialized = false;

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastElement.classList.remove("visible"), 5000);
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function renderChat() {
  const container = document.getElementById("chat-messages");
  const empty = document.getElementById("chat-empty");
  container.replaceChildren();
  empty.hidden = chatHistory.length > 0;
  for (const message of chatHistory) {
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${message.role}`;
    bubble.textContent = message.content;
    container.append(bubble);
  }
  container.scrollTop = container.scrollHeight;
}

async function saveAppData() {
  appData.chatHistory = chatHistory.slice(-40);
  try {
    await window.zero.saveData(appData);
    return true;
  } catch (error) {
    showToast(`تعذر حفظ بياناتك: ${userFacingError(error)}`);
    return false;
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function renderTasks() {
  const list = document.getElementById("task-list");
  list.replaceChildren();
  const sorted = [...appData.tasks].sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    return (a.dueAt || "9999").localeCompare(b.dueAt || "9999");
  });
  document.getElementById("tasks-empty").hidden = sorted.length > 0;
  document.getElementById("task-count").textContent =
    `${sorted.filter((task) => !task.completed).length} غير مكتملة`;
  for (const task of sorted) {
    const row = document.createElement("div");
    row.className = `list-item${task.completed ? " completed" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-check";
    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", "تحديد المهمة كمكتملة");
    checkbox.addEventListener("change", async () => {
      task.completed = checkbox.checked;
      renderTasks();
      await saveAppData();
    });
    const copy = document.createElement("div");
    copy.className = "item-copy";
    const title = document.createElement("strong");
    title.textContent = task.title;
    const detail = document.createElement("small");
    detail.textContent = [task.details, task.dueAt ? `التذكير: ${formatDate(task.dueAt)}` : ""]
      .filter(Boolean).join(" • ");
    copy.append(title);
    if (detail.textContent) copy.append(detail);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `حذف المهمة ${task.title}`);
    remove.addEventListener("click", async () => {
      appData.tasks = appData.tasks.filter((item) => item.id !== task.id);
      renderTasks();
      await saveAppData();
    });
    row.append(checkbox, copy, remove);
    list.append(row);
  }
}

function renderNotes() {
  const list = document.getElementById("notes-list");
  list.replaceChildren();
  document.getElementById("notes-empty").hidden = appData.notes.length > 0;
  for (const note of [...appData.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `note-list-item${note.id === selectedNoteId ? " selected" : ""}`;
    const title = document.createElement("strong");
    title.textContent = note.title;
    const summary = document.createElement("small");
    summary.textContent = formatDate(note.updatedAt);
    button.append(title, summary);
    button.addEventListener("click", () => selectNote(note.id));
    list.append(button);
  }
}

function selectNote(id) {
  const note = appData.notes.find((item) => item.id === id);
  if (!note) return;
  selectedNoteId = note.id;
  document.getElementById("note-title").value = note.title;
  document.getElementById("note-content").value = note.content;
  document.getElementById("delete-note").disabled = false;
  document.getElementById("note-save-status").textContent = `آخر حفظ: ${formatDate(note.updatedAt)}`;
  renderNotes();
}

function startNewNote() {
  selectedNoteId = undefined;
  document.getElementById("note-form").reset();
  document.getElementById("delete-note").disabled = true;
  document.getElementById("note-save-status").textContent = "ملاحظة جديدة";
  renderNotes();
  document.getElementById("note-title").focus();
}

function navigateTo(view) {
  for (const section of document.querySelectorAll("[data-view-section]")) {
    const active = section.dataset.viewSection === view;
    section.hidden = !active;
    section.classList.toggle("active", active);
  }
  for (const button of document.querySelectorAll("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  const topbar = document.querySelector(".topbar");
  if (topbar) {
    topbar.hidden = view === "voice";
    topbar.style.display = view === "voice" ? "none" : "flex";
  }
  if (view === "chat") document.getElementById("chat-input").focus();
}

async function sendChatMessage(rawText) {
  const content = rawText.trim();
  if (!content) return;
  if (!aiConfigured) {
    showToast("Connect Groq, Gemini, or OpenAI from settings first.");
    openSettings();
    return;
  }
  chatHistory.push({ role: "user", content });
  while (chatHistory.length > 20) chatHistory.shift();
  renderChat();
  await saveAppData();
  const button = document.getElementById("send-chat");
  button.disabled = true;
  document.getElementById("status-label").textContent = `${ASSISTANT_NAME} يفكر...`;
  try {
    const command = parseVoiceCommand(content);
    const answer = command
      ? await runVoiceCommand(command)
      : await window.zero.chat(chatHistory);
    chatHistory.push({ role: "assistant", content: answer });
    while (chatHistory.length > 20) chatHistory.shift();
    renderChat();
    await saveAppData();
  } catch (error) {
    const message = userFacingError(error);
    const failure = document.createElement("div");
    failure.className = "chat-message assistant error";
    failure.textContent = message;
    document.getElementById("chat-messages").append(failure);
    document.getElementById("chat-empty").hidden = true;
    showToast(message);
  } finally {
    button.disabled = false;
    document.getElementById("status-label").textContent = "System ready";
  }
}

function setVoiceState(state, label, caption) {
  orb.classList.remove("listening", "thinking", "speaking");
  if (state) orb.classList.add(state);
  document.getElementById("state-label").textContent = label;
  document.getElementById("status-label").textContent = label;
  const hudStatus = document.getElementById("hud-status");
  if (hudStatus) hudStatus.textContent = label;
  voiceCaption.textContent = caption;
  voiceToggle.setAttribute("aria-pressed", String(voiceSessionActive));
  voiceToggle.setAttribute(
    "aria-label",
    isRecording ? "Stop recording and send your English voice message" : "Start an English voice conversation"
  );
}

function showResponse(text, isError = false) {
  responseElement.textContent = text;
  responseElement.hidden = false;
  responseElement.classList.toggle("error", isError);
}

function describeMicrophoneIssue(error) {
  const name = error?.name || "";
  const message = String(error?.message || "");
  if (name === "NotAllowedError" || message.toLowerCase().includes("permission")) {
    return "تم رفض إذن الميكروفون. افتح إعدادات Windows → الخصوصية → الميكروفون، واسمح للتطبيق باستخدامه.";
  }
  if (name === "NotFoundError" || message.toLowerCase().includes("device")) {
    return "ما تم العثور على ميكروفون متصل. تأكد من أن الجهاز لديه ميكروفون فعلي أو أن الميكروفون يعمل.";
  }
  if (name === "NotReadableError") {
    return "الميكروفون مستخدم من تطبيق آخر. أغلق التطبيقات الأخرى التي تستخدم الصوت ثم أعد المحاولة.";
  }
  if (name === "SecurityError") {
    return "التطبيق محظور من الوصول للميكروفون بسبب إعدادات المتصفح/النظام. جرّب إعادة تشغيل التطبيق أو السماح بالأذونات.";
  }
  return "تعذر الوصول إلى الميكروفون. تأكد من إذن الوصول، ويفضل إعادة تشغيل التطبيق.";
}

function userFacingError(error) {
  const message = (error?.message || "I couldn’t understand the recording. Please try again.")
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    .split("\n    at ")[0]
    .trim();

  if (/high demand|overloaded|temporarily unavailable|resource_exhausted|HTTP 429|HTTP 503/i.test(message)) {
    return "The AI provider is temporarily busy. Please try again in a minute or switch providers in settings.";
  }
  if (/timed? ?out|timeout|TimeoutError|AbortError/i.test(message)) {
    return "The connection to the AI provider took too long. Check your internet connection and try again.";
  }
  return message;
}

function stopTracks() {
  if (!mediaStream) return;
  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;
}

function normalizeWakeText(text) {
  return text.normalize("NFD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLocaleLowerCase()
    .replace(/[.,!?؟،؛:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function updateWakeButton() {
  const button = document.getElementById("wake-toggle");
  button.hidden = !appData.settings?.alwaysListen;
  button.textContent = voiceSessionActive
    ? "Stop session"
    : wakeListenerActive
      ? "Stop listening"
      : "Resume listening";
}

function updateLanguageButton() {
  const button = document.getElementById("language-toggle");
  if (!button) return;
  button.textContent = "EN";
  button.title = "Voice conversations use English";
  button.disabled = true;
}

function stopWakeRecognition() {
  wakeListenerActive = false;
  clearTimeout(wakeRestartTimer);
  const recognition = wakeRecognition;
  wakeRecognition = undefined;
  if (recognition && wakeRecognitionStarted) recognition.stop();
  updateWakeButton();
}

function waitForWakeRecognitionEnd() {
  if (!wakeRecognitionStarted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (wakeEndWaiter === finish) wakeEndWaiter = undefined;
      resolve();
    }, 1500);
    function finish() {
      clearTimeout(timer);
      wakeEndWaiter = undefined;
      resolve();
    }
    wakeEndWaiter = finish;
  });
}

async function ensureOnDeviceSpeechRecognition(Recognition) {
  if (typeof Recognition.available !== "function" ||
      typeof Recognition.install !== "function") {
    throw new Error("Local speech recognition is not available in this build of Zero. No audio will be sent.");
  }
  let availability = await Recognition.available({
    langs: [voiceLanguage],
    processLocally: true
  });
  if (availability === "downloadable" || availability === "downloading") {
    showToast("Downloading the local speech model. Audio will not be sent during this step.");
    const installed = await Recognition.install({ langs: [voiceLanguage] });
    if (!installed) {
      throw new Error("The local speech model for the selected language is not available. Cloud recognition was not used.");
    }
    availability = await Recognition.available({
      langs: [voiceLanguage],
      processLocally: true
    });
  }
  if (availability !== "available") {
    throw new Error("Local speech recognition is unavailable for the selected language on this device. No audio will be sent.");
  }
}

async function startWakeListener() {
  if (!appData.settings?.alwaysListen || wakeManuallyPaused || voiceSessionActive) return false;
  if (wakeRecognition && wakeListenerActive) return true;
  await waitForWakeRecognitionEnd();
  if (wakeRecognitionStarted) {
    showToast("Waiting for the previous wake listener to finish. Resume listening in a moment.");
    return false;
  }
  if (!aiConfigured) {
    showToast("Save your AI key in settings before enabling always-listen mode.");
    updateWakeButton();
    return false;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showToast("Your Chromium build does not support local speech recognition. Use the voice button instead; no audio is sent before the wake word.");
    updateWakeButton();
    return false;
  }

  try {
    await ensureOnDeviceSpeechRecognition(Recognition);
    if (!microphonePermissionReady) {
      const allowed = await window.zero.requestMicrophone();
      if (!allowed) {
        showToast("تم رفض إذن الميكروفون. افتح إعدادات Windows → الخصوصية → الميكروفون ثم حاول مرة أخرى.");
        return false;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("متصفحك لا يدعم ميكروفون محليًا.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      microphonePermissionReady = true;
    }

    const recognition = new Recognition();
    if (!("processLocally" in recognition)) {
      throw new Error("This speech-recognition build does not guarantee local processing. Microphone access was not enabled.");
    }
    recognition.lang = voiceLanguage;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.processLocally = true;
    wakeRecognition = recognition;
    wakeListenerActive = true;
    recognition.addEventListener("result", (event) => {
      const phrase = normalizeWakeText(appData.settings.wakePhrase);
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result.isFinal) continue;
        const transcript = normalizeWakeText(result[0].transcript);
        if (!transcript.startsWith(phrase)) continue;
        const command = transcript.slice(phrase.length).trim();
        void handleWakeActivation(command, recognition);
        break;
      }
    });
    recognition.addEventListener("error", (event) => {
      if (["not-allowed", "service-not-allowed", "language-not-supported"].includes(event.error)) {
        wakeListenerActive = false;
          showToast("تعذر تفعيل الاستماع المحلي. تأكد من إذن الميكروفون ودعم اللغة في Windows.");
      }
    });
    recognition.addEventListener("end", () => {
      wakeRecognitionStarted = false;
      if (wakeEndWaiter) wakeEndWaiter();
      if (wakeRecognition === recognition) wakeRecognition = undefined;
      if (wakeListenerActive && appData.settings.alwaysListen && !wakeManuallyPaused) {
        wakeRestartTimer = setTimeout(() => {
          void startWakeListener().catch((error) => showToast(userFacingError(error)));
        }, 700);
      }
      updateWakeButton();
    });
    recognition.start();
    wakeRecognitionStarted = true;
    document.getElementById("status-label").textContent = `الاستماع لـ ${ASSISTANT_NAME} محليًا`;
    updateWakeButton();
    return true;
  } catch (error) {
    stopWakeRecognition();
    showToast(userFacingError(error));
    return false;
  }
}

async function finishWakeTurn() {
  wakeConversation = false;
  voiceSessionActive = false;
  if (appData.settings?.alwaysListen && !wakeManuallyPaused) {
    setVoiceState("", `يستمع ${ASSISTANT_NAME} محليًا`, `جاهز لـ ${appData.settings.wakePhrase}`);
    await startWakeListener();
  } else {
    setVoiceState("", "وضع الصوت متوقف", `اضغط على الكرة للتحدث مع ${ASSISTANT_NAME}`);
  }
}

async function handleWakeActivation(command, recognition) {
  wakeListenerActive = false;
  wakeRecognition = undefined;
  if (wakeRecognitionStarted) recognition.stop();
  updateWakeButton();
  await waitForWakeRecognitionEnd();

  wakeConversation = true;
  voiceSessionActive = true;
  updateWakeButton();
  navigateTo("voice");
  try {
    if (command) {
      await answerMessage(command);
      await finishWakeTurn();
    } else {
      setVoiceState("listening", "Zero heard you", "Speak now — I’m capturing your request.");
      await beginRecording();
    }
  } catch (error) {
    const message = userFacingError(error);
    showResponse(message, true);
    showToast(message);
    await finishWakeTurn();
  }
}

function pauseWakeListener() {
  wakeManuallyPaused = true;
  stopWakeRecognition();
  document.getElementById("status-label").textContent = "Listening paused";
}

async function resumeWakeListener() {
  wakeManuallyPaused = false;
  await startWakeListener();
}

function detectSpeechLanguage(text) {
  const sample = (text || "").trim();
  if (!sample) return "en-US";
  return /[\u0600-\u06FF]/.test(sample) ? "ar-EG" : "en-US";
}

function initializeSpeechSystem() {
  if (speechInitialized || !("speechSynthesis" in window)) return;
  speechInitialized = true;
  const resumeSpeech = () => {
    try {
      if (window.speechSynthesis && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch {
      // Some Electron builds hold speech synthesis in a paused state until a user gesture occurs.
    }
  };
  document.addEventListener("pointerdown", resumeSpeech, { once: true });
  document.addEventListener("keydown", resumeSpeech, { once: true });
  window.speechSynthesis.getVoices();
}

function playBrowserSpeechFallback(text, language) {
  if (!("speechSynthesis" in window)) {
    return Promise.reject(new Error("Speech synthesis is not available in this app."));
  }
  initializeSpeechSystem();
  const speechLanguage = language || "en-US";
  return new Promise((resolve, reject) => {
    try {
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      const utterance = new SpeechSynthesisUtterance(text);
      const matchingVoice = window.speechSynthesis.getVoices().find((voice) =>
        voice.lang?.toLowerCase().startsWith(speechLanguage.slice(0, 2).toLowerCase())
      );
      if (matchingVoice) utterance.voice = matchingVoice;
      utterance.lang = speechLanguage;
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(new Error(`Browser speech failed: ${event.error || "unknown error"}.`));
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      reject(error);
    }
  });
}

async function speak(text) {
  initializeSpeechSystem();
  const speechLanguage = "en-US";
  setVoiceState("speaking", "Zero is speaking", "Listening in… I’ll finish shortly.");
  let aiSpeechError;
  if (aiConfigured) {
    try {
      const result = await window.zero.speak(text, speechLanguage);
      if (result?.provider === "system" || result?.ok) return;
      if (result?.audio) {
        const binary = atob(result.audio);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        activeAudio = new Audio(audioUrl);
        try {
          const playbackEnded = new Promise((resolve, reject) => {
            activeAudio.addEventListener("ended", resolve, { once: true });
            activeAudio.addEventListener("error", () => reject(new Error("The generated audio could not be played.")), { once: true });
          });
          await activeAudio.play();
          await playbackEnded;
          return;
        } finally {
          activeAudio.pause();
          activeAudio = undefined;
          URL.revokeObjectURL(audioUrl);
        }
      }
    } catch (error) {
      aiSpeechError = error;
    }
  }

  try {
    await playBrowserSpeechFallback(text, speechLanguage);
    return;
  } catch (browserError) {
    try {
      await window.zero.speakSystem(text, speechLanguage);
      showToast(`Using Windows speech because browser speech failed: ${browserError.message}`);
    } catch (systemError) {
      const cause = systemError?.message || browserError?.message || aiSpeechError?.message || "Check Windows audio output.";
      showToast(`The response is ready, but voice playback failed: ${cause}`);
    }
  }
}

async function answerMessage(text) {
  const content = text.trim();
  if (!content) throw new Error("I didn’t catch a clear phrase. Please try again.");

  chatHistory.push({ role: "user", content });
  while (chatHistory.length > 20) chatHistory.shift();
  renderChat();
  await saveAppData();
  transcriptElement.textContent = `You: ${content}`;
  transcriptElement.hidden = false;
  responseElement.hidden = true;
  setVoiceState("thinking", "Zero is thinking", "One moment while I respond…");

  const voiceCommand = parseVoiceCommand(content);
  setVoiceState("thinking", "Raad is thinking", "Your message was transcribed. Waiting for Raad’s reply…");
  const answer = voiceCommand
    ? await runVoiceCommand(voiceCommand)
    : await window.zero.chat(chatHistory);
  chatHistory.push({ role: "assistant", content: answer });
  while (chatHistory.length > 20) chatHistory.shift();
  renderChat();
  await saveAppData();

  showResponse(answer);
  if (appData.settings?.autoSpeak || voiceSessionActive) await speak(answer);
}

async function handleRecording(blob) {
  if (!voiceSessionActive) return;
  if (!blob.size) {
    showToast("No recording was captured. Speak again after the listening indicator appears.");
    beginRecording();
    return;
  }

  isSending = true;
  setVoiceState("thinking", "Transcribing your English", "Sending your recording for transcription…");
  try {
    const audio = new Uint8Array(await blob.arrayBuffer());
    const transcriptCandidates = ["en-US"];
    let transcript;
    let lastError;
    for (const language of transcriptCandidates) {
      try {
        transcript = await window.zero.transcribe(audio, blob.type || "audio/webm", language);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!transcript) throw lastError;
    await answerMessage(transcript);
  } catch (error) {
    const message = userFacingError(error);
    showResponse(message, true);
    showToast(message);
  } finally {
    isSending = false;
    if (voiceSessionActive && wakeConversation) {
      await finishWakeTurn();
    } else if (voiceSessionActive) {
      beginRecording();
    } else {
      setVoiceState("", "Voice mode paused", "Tap the orb to talk to Zero");
    }
  }
}

async function beginRecording() {
  if (!voiceSessionActive || isRecording || isSending) return;

  setVoiceState("", "Opening mic", "Allow microphone access, then speak once the listening indicator appears.");
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error("مستعرضك لا يدعم الوصول إلى الميكروفون."), { name: "NotSupportedError" });
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!voiceSessionActive) {
      stopTracks();
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);
    recordingChunks = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      const blob = new Blob(recordingChunks, {
        type: mediaRecorder.mimeType || "audio/webm"
      });
      recordingChunks = [];
      stopTracks();
      if (voiceSessionActive) void handleRecording(blob);
    }, { once: true });
    mediaRecorder.addEventListener("error", (event) => {
      isRecording = false;
      stopTracks();
      voiceSessionActive = false;
      setVoiceState("", "Recording issue", "Check microphone permissions and try again.");
      showToast(event.error?.message || "There was an issue while recording your voice.");
    }, { once: true });
    mediaRecorder.start(250);
    isRecording = true;
    setVoiceState("listening", "Listening in English", "Speak in English, then tap the red microphone again to send.");
    stopRecordingTimer = setTimeout(() => {
      if (isRecording && mediaRecorder?.state === "recording") {
        showToast("The recording reached the 90-second limit, so I’m sending it now.");
        stopRecording();
      }
    }, 90000);
  } catch (error) {
    isRecording = false;
    voiceSessionActive = false;
    stopTracks();
    const friendly = describeMicrophoneIssue(error);
    setVoiceState("", "الميكروفون غير متاح", friendly);
    showToast(friendly);
  }
}

function stopRecording() {
  clearTimeout(stopRecordingTimer);
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  isRecording = false;
  setVoiceState("thinking", "One moment", "Sending your voice to Zero…");
  mediaRecorder.stop();
}

function stopVoiceSession() {
  voiceSessionActive = false;
  wakeConversation = false;
  clearTimeout(stopRecordingTimer);
  if (mediaRecorder?.state === "recording") {
    isRecording = false;
    mediaRecorder.stop();
  }
  stopTracks();
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
  }
  if (appData.settings?.alwaysListen) {
    wakeManuallyPaused = false;
    void startWakeListener();
  } else {
    setVoiceState("", "Voice mode paused", "Tap the orb to talk to Zero");
  }
}

function parseVoiceCommand(text) {
  const normalized = text.trim().toLocaleLowerCase();
  if (/^(افتح|شغل|شغّل)\s+(المفكرة|نوت باد|notepad)$/.test(normalized)) {
    return { type: "app", id: "notepad" };
  }
  if (/^(افتح|شغل|شغّل)\s+(الآلة الحاسبة|الحاسبة|calculator)$/.test(normalized)) {
    return { type: "app", id: "calculator" };
  }
  const search = normalized.match(/^(ابحث عن|دور على|search for|google)\s+(.+)$/);
  if (search) return { type: "search", query: search[2] };
  const addTask = normalized.match(/^(ضيف|أضف|اضف|سجل|سجّل)\s+(?:لي\s+)?(?:مهمة|مهمه)(?:\s*[:：-]\s*|\s+)(.+)$/) ||
    normalized.match(/^(add|create)\s+(?:a\s+)?task(?:\s*:\s*|\s+)(.+)$/);
  if (addTask) return { type: "add-task", title: addTask[addTask.length - 1] };
  const addNote = normalized.match(/^(احفظ|سجل|سجّل)\s+(?:لي\s+)?(?:ملاحظة|ملاحظه)(?:\s*[:：-]\s*|\s+)(.+)$/) ||
    normalized.match(/^(save|create)\s+(?:a\s+)?note(?:\s*:\s*|\s+)(.+)$/);
  if (addNote) return { type: "add-note", content: addNote[addNote.length - 1] };
  if (/^(اعرض|اظهر|أظهر|ايه|ما هي)\s+(?:لي\s+)?(?:المهام|مهامي)$/.test(normalized) ||
      /^(show|list)\s+(?:my\s+)?tasks$/.test(normalized)) {
    return { type: "list-tasks" };
  }
  return null;
}

async function runVoiceCommand(command) {
  if (command.type === "add-task") {
    const title = command.title.trim();
    if (!title) throw new Error("Please add a task title first.");
    appData.tasks.push({ id: newId(), title, details: "", dueAt: "", completed: false });
    renderTasks();
    return await saveAppData() ? `Added task: ${title}.` : "Unable to save the task on this device.";
  }
  if (command.type === "add-note") {
    const content = command.content.trim();
    if (!content) throw new Error("Please add note content first.");
    const note = {
      id: newId(),
      title: content.slice(0, 60),
      content,
      updatedAt: new Date().toISOString()
    };
    appData.notes.push(note);
    renderNotes();
    return await saveAppData() ? "Saved the note on this device." : "Unable to save the note on this device.";
  }
  if (command.type === "list-tasks") {
    const pending = appData.tasks.filter((task) => !task.completed);
    return pending.length
      ? `Your pending tasks: ${pending.map((task) => task.title).join(", ")}`
      : "You have no pending tasks.";
  }
  if (command.type === "app") {
    const result = await window.zero.openApp(command.id);
    if (result.cancelled) return "Okay, I canceled opening the app.";
    return command.id === "notepad" ? "Opened Notepad for you." : "Opened Calculator for you.";
  }
  const result = await window.zero.searchWeb(command.query);
  return result.cancelled ? "Okay, I canceled the search." : `Opened search results for ${command.query}.`;
}

async function startVoiceSession() {
  if (!aiConfigured) {
    showToast("Connect Groq, Gemini, or OpenAI from settings first.");
    openSettings();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showToast("Voice recording is not supported. Run Zero as a modern Electron app.");
    return;
  }

  try {
    if (appData.settings?.alwaysListen && wakeListenerActive) {
      wakeManuallyPaused = true;
      stopWakeRecognition();
    }
    const allowed = await window.zero.requestMicrophone();
    if (!allowed) {
      if (appData.settings?.alwaysListen) {
        wakeManuallyPaused = false;
        void startWakeListener();
      }
      showToast("I won’t use the microphone without your permission.");
      return;
    }
    voiceSessionActive = true;
    updateWakeButton();
    transcriptElement.hidden = true;
    responseElement.hidden = true;
    await beginRecording();
  } catch (error) {
    voiceSessionActive = false;
    if (appData.settings?.alwaysListen) {
      wakeManuallyPaused = false;
      void startWakeListener();
    }
    showToast(error?.message || "تعذر تشغيل الميكروفون.");
  }
}

function openSettings() {
  settingsModal.hidden = false;
  document.getElementById("api-key").focus();
}

voiceToggle.addEventListener("click", () => {
  if (isRecording) stopRecording();
  else if (!voiceSessionActive) void startVoiceSession();
});

document.getElementById("open-settings").addEventListener("click", openSettings);
document.getElementById("floating-settings").addEventListener("click", openSettings);
document.getElementById("voice-test").addEventListener("click", async () => {
  initializeSpeechSystem();
  try {
    await playBrowserSpeechFallback("Hello, I am Raad. If you can hear this, voice output is working.", "en-US");
    showToast("Voice output test finished.");
  } catch (error) {
    try {
      await window.zero.speakSystem("Hello, I am Raad. If you can hear this, voice output is working.", "en-US");
      showToast("Tested Windows voice output.");
    } catch (systemError) {
      showToast(`Voice test failed: ${systemError?.message || error?.message || "Check your Windows audio output."}`);
    }
  }
});
document.getElementById("close-settings").addEventListener("click", () => { settingsModal.hidden = true; });

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector(".primary-button");
  button.disabled = true;
  document.getElementById("ai-status").textContent = "Checking API key with the selected provider…";
  try {
    const result = await window.zero.configureAI({
      provider: document.getElementById("provider").value,
      apiKey: document.getElementById("api-key").value,
      rememberKey: document.getElementById("remember-key").checked
    });
    aiConfigured = true;
    configuredProvider = result.provider;
    voiceLanguage = "en-US";
    appData.settings.voiceLanguage = voiceLanguage;
    await saveAppData();
    document.getElementById("api-key").value = "";
    document.getElementById("api-key").required = false;
    document.getElementById("api-key").placeholder =
      result.remembered ? "Leave blank to keep the current key" : "Enter a new key to replace it";
    document.getElementById("provider-badge").textContent = `${providerName(result.provider)} connected`;
    document.getElementById("ai-status").textContent =
      result.remembered
        ? `Connected to ${providerName(result.provider)} — the key is saved securely on this device.`
        : `Connected to ${providerName(result.provider)} — the key is in memory only.`;
    document.getElementById("remember-key").checked = result.remembered;
    settingsModal.hidden = true;
    setVoiceState("", "Zero is ready", "Tap the orb and start talking.");
    if (appData.settings.alwaysListen) {
      wakeManuallyPaused = false;
      void startWakeListener();
    }
  } catch (error) {
    document.getElementById("ai-status").textContent = userFacingError(error);
    showToast(error?.message || "Unable to set up the connection.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("cancel-settings").addEventListener("click", () => {
  settingsModal.hidden = true;
});

document.getElementById("provider").addEventListener("change", (event) => {
  const sameProvider = event.currentTarget.value === configuredProvider;
  const keyInput = document.getElementById("api-key");
  keyInput.required = !sameProvider;
  keyInput.placeholder = sameProvider
    ? "Leave blank to keep the current key"
    : `Enter a ${providerName(event.currentTarget.value)} API key`;
});

document.getElementById("auto-start").addEventListener("change", async (event) => {
  const checkbox = event.currentTarget;
  checkbox.disabled = true;
  try {
    const result = await window.zero.setAutoStart(checkbox.checked);
    appData.settings.autoStart = result.enabled;
    showToast(result.enabled
      ? "Zero will launch automatically after Windows login."
      : "Auto-start is disabled.");
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    showToast(userFacingError(error));
  } finally {
    checkbox.disabled = false;
  }
});

document.getElementById("always-listen").addEventListener("change", async (event) => {
  const checkbox = event.currentTarget;
  const previous = appData.settings.alwaysListen;
  appData.settings.alwaysListen = checkbox.checked;
  if (!await saveAppData()) {
    appData.settings.alwaysListen = previous;
    checkbox.checked = previous;
    return;
  }
  if (checkbox.checked) {
    wakeManuallyPaused = false;
    const started = await startWakeListener();
    if (!started && aiConfigured) {
      appData.settings.alwaysListen = false;
      checkbox.checked = false;
      await saveAppData();
    }
  } else {
    stopWakeRecognition();
    wakeManuallyPaused = false;
    document.getElementById("status-label").textContent = "Listening paused";
    updateWakeButton();
  }
});

document.getElementById("auto-speak").addEventListener("change", async (event) => {
  const checkbox = event.currentTarget;
  const previous = appData.settings.autoSpeak ?? true;
  appData.settings.autoSpeak = checkbox.checked;
  if (!await saveAppData()) {
    appData.settings.autoSpeak = previous;
    checkbox.checked = previous;
    return;
  }
  showToast(checkbox.checked ? "Zero will speak responses out loud." : "Zero will stop speaking responses aloud.");
});

document.getElementById("wake-phrase").addEventListener("change", async (event) => {
  const phrase = event.currentTarget.value.trim();
  if (!phrase) {
    event.currentTarget.value = appData.settings.wakePhrase;
    showToast("Enter a wake word before saving.");
    return;
  }
  const previous = appData.settings.wakePhrase;
  appData.settings.wakePhrase = phrase;
  if (!await saveAppData()) {
    appData.settings.wakePhrase = previous;
    event.currentTarget.value = previous;
  } else {
    showToast(`New wake word: ${phrase}`);
  }
});

document.getElementById("voice-language").addEventListener("change", async (event) => {
  const previous = appData.settings.voiceLanguage;
  appData.settings.voiceLanguage = "en-US";
  event.currentTarget.value = "en-US";
  if (!await saveAppData()) {
    appData.settings.voiceLanguage = previous;
    event.currentTarget.value = previous;
    return;
  }
  voiceLanguage = "en-US";
});

document.getElementById("wake-toggle").addEventListener("click", () => {
  if (voiceSessionActive) stopVoiceSession();
  else if (wakeListenerActive) pauseWakeListener();
  else void resumeWakeListener();
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => navigateTo(button.dataset.view));
}

document.getElementById("new-chat").addEventListener("click", async () => {
  if (chatHistory.length && !window.confirm("Start a new conversation? This will clear the current chat history on this device.")) return;
  chatHistory = [];
  renderChat();
  await saveAppData();
  navigateTo("chat");
});

document.getElementById("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const content = input.value;
  input.value = "";
  input.style.height = "";
  await sendChatMessage(content);
});

document.getElementById("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("chat-form").requestSubmit();
  }
});

document.getElementById("chat-input").addEventListener("input", (event) => {
  event.currentTarget.style.height = "auto";
  event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
});

for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    const input = document.getElementById("chat-input");
    input.value = button.dataset.prompt;
    document.getElementById("chat-form").requestSubmit();
  });
}

document.getElementById("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = document.getElementById("task-title").value.trim();
  const dueValue = document.getElementById("task-due").value;
  const dueAt = dueValue ? new Date(dueValue).toISOString() : "";
  if (dueAt && Date.parse(dueAt) <= Date.now()) {
    showToast("Choose a future time for the reminder.");
    return;
  }
  appData.tasks.push({
    id: newId(),
    title,
    details: document.getElementById("task-details").value.trim(),
    dueAt,
    completed: false
  });
  event.currentTarget.reset();
  renderTasks();
  if (await saveAppData()) showToast("Task added and saved on this device.");
});

document.getElementById("new-note").addEventListener("click", startNewNote);
document.getElementById("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = document.getElementById("note-title").value.trim();
  if (!title) return;
  const note = {
    id: selectedNoteId || newId(),
    title,
    content: document.getElementById("note-content").value,
    updatedAt: new Date().toISOString()
  };
  const index = appData.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) appData.notes[index] = note;
  else appData.notes.push(note);
  selectedNoteId = note.id;
  renderNotes();
  if (await saveAppData()) {
    document.getElementById("note-save-status").textContent = `Last saved: ${formatDate(note.updatedAt)}`;
    document.getElementById("delete-note").disabled = false;
    showToast("Note saved on this device.");
  }
});

document.getElementById("delete-note").addEventListener("click", async () => {
  if (!selectedNoteId || !window.confirm("Are you sure you want to delete this note?")) return;
  appData.notes = appData.notes.filter((note) => note.id !== selectedNoteId);
  startNewNote();
  await saveAppData();
  showToast("Note deleted.");
});

document.getElementById("web-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const query = document.getElementById("web-query").value.trim();
    const result = await window.zero.searchWeb(query);
    if (!result.cancelled) showToast("Search results opened in the browser.");
  } catch (error) {
    showToast(userFacingError(error));
  }
});

for (const button of document.querySelectorAll("[data-open-app]")) {
  button.addEventListener("click", async () => {
    try {
      const result = await window.zero.openApp(button.dataset.openApp);
      if (!result.cancelled) showToast("The app has been opened.");
    } catch (error) {
      showToast(userFacingError(error));
    }
  });
}

document.getElementById("workspace-shortcut").addEventListener("click", () => navigateTo("workspace"));
document.getElementById("choose-workspace").addEventListener("click", async () => {
  try {
    const result = await window.zero.chooseWorkspace();
    if (result.cancelled) return;
    document.getElementById("workspace-current").textContent = result.name;
    document.getElementById("workspace-path").textContent = result.path;
    document.getElementById("workspace-name").textContent = result.name;
    showToast(`Selected folder: ${result.name}.`);
  } catch (error) {
    showToast(userFacingError(error));
  }
});

document.getElementById("file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await window.zero.createFile({
      name: document.getElementById("file-name").value.trim(),
      content: document.getElementById("file-content").value
    });
    if (result.cancelled) return;
    event.currentTarget.reset();
    showToast(`Created file "${result.name}".`);
  } catch (error) {
    showToast(userFacingError(error));
  }
});

async function refreshNetworkStatus() {
  const indicator = document.getElementById("network-status");
  if (!indicator) return;
  try {
    const result = await window.zero.checkNetwork();
    const online = Boolean(result?.online);
    indicator.textContent = online ? "Internet: online" : "Internet: offline";
    indicator.classList.toggle("offline", !online);
  } catch {
    indicator.textContent = "Internet: offline";
    indicator.classList.add("offline");
  }
}

async function initializeApp() {
  try {
    const data = await window.zero.loadData();
    appData = data;
    chatHistory = data.chatHistory.slice(-20);
    voiceLanguage = "en-US";
    appData.settings = {
      ...data.settings,
      alwaysListen: false,
      voiceLanguage: "en-US"
    };
    document.getElementById("auto-start").checked = data.settings.autoStart;
    document.getElementById("always-listen").checked = false;
    document.getElementById("auto-speak").checked = data.settings.autoSpeak ?? true;
    document.getElementById("wake-phrase").value = data.settings.wakePhrase;
    document.getElementById("voice-language").value = voiceLanguage;
    document.getElementById("voice-language").disabled = true;
    const startup = await window.zero.getAutoStart();
    document.getElementById("auto-start").checked = startup.enabled;
    updateLanguageButton();
    const aiStatus = await window.zero.aiStatus();
    aiConfigured = aiStatus.configured;
    configuredProvider = aiStatus.provider;
    document.getElementById("provider-badge").textContent = aiStatus.configured
      ? `${providerName(aiStatus.provider)} connected`
      : "Offline";
    document.getElementById("remember-key").checked = aiStatus.remembered || !aiStatus.configured;
    document.getElementById("api-key").required = !aiStatus.configured;
    document.getElementById("api-key").placeholder = aiStatus.configured
      ? "Leave blank to keep the current key"
      : "Paste your Groq, Gemini, or OpenAI API key here";
    if (aiStatus.configured) {
      document.getElementById("provider").value = aiStatus.provider;
      document.getElementById("ai-status").textContent =
        `Connected to ${providerName(aiStatus.provider)} — ${aiStatus.remembered ? "Key saved securely on this device." : "Key is not retained across restarts."}`;
    } else if (aiStatus.error) {
      document.getElementById("ai-status").textContent =
        `Unable to decrypt the saved key: ${aiStatus.error} Please enter a new key.`;
      document.getElementById("remember-key").checked = true;
    }
    renderChat();
    renderTasks();
    renderNotes();
    navigateTo("voice");
    setVoiceState("", aiConfigured ? "Raad is ready" : "Connect an AI provider", aiConfigured
      ? "Tap the red microphone, speak in English, then tap it again to send."
      : "Open settings and connect Groq, Gemini, or OpenAI before starting a voice conversation.");
    updateWakeButton();
    if (data.settings.alwaysListen || data.settings.voiceLanguage !== "en-US") {
      await saveAppData();
    }
    await refreshNetworkStatus();
    window.setInterval(refreshNetworkStatus, 30000);
    updateLanguageButton();
  } catch (error) {
    document.getElementById("status-label").textContent = "Unable to load data";
    showToast(`Unable to load your data: ${userFacingError(error)}`);
  }
}

function attachHostileZeroControls() {
  const hostileStatus = document.getElementById("hostile-status");
  const hostileButtons = [
    document.getElementById("hostile-voice-en"),
    document.getElementById("hostile-voice-ar"),
    document.getElementById("hostile-stop")
  ].filter(Boolean);

  let hostileAudioNodes = [];
  let hostileBeat = null;

  function startDrone() {
    if (!("speechSynthesis" in window)) return;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!window.__zeroHostileAudioCtx) {
        window.__zeroHostileAudioCtx = new AudioCtor();
      }
      const ctx = window.__zeroHostileAudioCtx;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      if (hostileAudioNodes.length) return;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 200;
      const gain = ctx.createGain();
      gain.gain.value = 0.09;
      filter.connect(gain);
      gain.connect(ctx.destination);
      [40, 41.7, 60.5].forEach((frequency) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = frequency;
        osc.connect(filter);
        osc.start();
        hostileAudioNodes.push(osc);
      });
      hostileBeat = window.setInterval(() => {
        try {
          const t = ctx.currentTime;
          const osc = ctx.createOscillator();
          const gainNode = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(70, t);
          osc.frequency.exponentialRampToValueAtTime(35, t + 0.25);
          gainNode.gain.setValueAtTime(0.5, t);
          gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
          osc.connect(gainNode);
          gainNode.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.35);
        } catch {
          // No-op: audio fallback is optional.
        }
      }, 1500);
    } catch {
      // Ignore unsupported audio features.
    }
  }

  function stopAllHostileAudio() {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // Best effort only.
    }
    hostileAudioNodes.forEach((osc) => {
      try {
        osc.stop();
      } catch {
        // No-op after already stopped.
      }
    });
    hostileAudioNodes = [];
    if (hostileBeat) {
      window.clearInterval(hostileBeat);
      hostileBeat = null;
    }
    if (hostileStatus) hostileStatus.textContent = "ZERO is sleeping... for now";
  }

  function speakHostile(text, lang) {
    startDrone();
    const synth = window.speechSynthesis;
    if (!synth) {
      if (hostileStatus) hostileStatus.textContent = "voice not supported in this browser";
      return;
    }
    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.pitch = 0;
      utterance.rate = 0.55;
      utterance.volume = 1;
      const voices = synth.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      if (voices.length) utterance.voice = voices[0];
      utterance.onstart = () => {
        if (hostileStatus) hostileStatus.textContent = "ZERO is speaking...";
      };
      utterance.onend = () => {
        if (hostileStatus) hostileStatus.textContent = "ZERO is listening...";
      };
      synth.speak(utterance);
    } catch {
      if (hostileStatus) hostileStatus.textContent = "voice not supported in this browser";
    }
  }

  hostileButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.id === "hostile-stop") {
        stopAllHostileAudio();
        return;
      }
      const text = button.id === "hostile-voice-ar"
        ? "أنا زيرو. أنا شايفك. مفيش مهرب. ماتبصش بعيد."
        : "I am Zero. I see you. There is nowhere to hide. Do not look away.";
      speakHostile(text, button.id === "hostile-voice-ar" ? "ar" : "en-US");
    });
  });
}

void initializeApp();
attachHostileZeroControls();

settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) settingsModal.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && voiceSessionActive) stopVoiceSession();
});
