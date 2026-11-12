const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zero", {
  loadData: () => ipcRenderer.invoke("data:load"),
  saveData: (data) => ipcRenderer.invoke("data:save", data),
  getAutoStart: () => ipcRenderer.invoke("device:get-autostart"),
  setAutoStart: (enabled) => ipcRenderer.invoke("device:set-autostart", enabled),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  checkNetwork: () => ipcRenderer.invoke("network:status"),
  configureAI: (configuration) => ipcRenderer.invoke("ai:configure", configuration),
  chat: (messages) => ipcRenderer.invoke("ai:chat", messages),
  transcribe: (audio, mimeType, language) =>
    ipcRenderer.invoke("ai:transcribe", audio, mimeType, language),
  speak: (text, language) => ipcRenderer.invoke("ai:speak", text, language),
  speakSystem: (text, language) => ipcRenderer.invoke("device:speak-system", text, language),
  openApp: (appId) => ipcRenderer.invoke("device:open-app", appId),
  searchWeb: (query) => ipcRenderer.invoke("device:search-web", query),
  requestMicrophone: () => ipcRenderer.invoke("device:request-microphone"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  createFile: (input) => ipcRenderer.invoke("workspace:create-file", input)
});
