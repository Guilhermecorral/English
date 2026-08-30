/**
 * ==============================================================================
 * GUIA DE JAVASCRIPT DIDÁTICO: Áudio em Tempo Real, WebSockets e DOM
 * ==============================================================================
 *
 * Conceitos aplicados aqui:
 * 1. Manipulação do DOM: Capturar botões, selects e atualizar histórico de mensagens.
 * 2. Web Audio API: Captura de microfone com fallback inteligente (AudioWorklet + ScriptProcessor).
 * 3. Conversão de Áudio (Downsample): Microfone (44.1k/48k) -> 16kHz Int16 PCM (padrão Gemini Live).
 * 4. WebSockets: Envio contínuo de áudio e recebimento das respostas com baixa latência.
 */

// ==========================================
// 1. SELEÇÃO DE ELEMENTOS DO DOM (HTML)
// ==========================================
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const scenarioCards = document.querySelectorAll('.scenario-card');
const voiceSelect = document.getElementById('voice-select');
const apiKeyInput = document.getElementById('api-key-input');
const micBtn = document.getElementById('mic-btn');
const actionPrompt = document.getElementById('action-prompt');
const visualizerCanvas = document.getElementById('visualizer');
const chatMessages = document.getElementById('chat-messages');
const clearChatBtn = document.getElementById('clear-chat-btn');

const canvasCtx = visualizerCanvas.getContext('2d');

// ==========================================
// 2. VARIÁVEIS DE ESTADO DA APLICAÇÃO
// ==========================================
let isSessionActive = false;
let currentScenario = 'barista';
let socket = null;

// Áudio Web API
let audioContext = null;
let mediaStream = null;
let scriptProcessorNode = null;
let dummyGainNode = null;
let analyserNode = null;

// Fila de reprodução de áudio do Gemini (24kHz PCM)
let nextStartTime = 0;
let activeAudioSourceNodes = [];

// ==========================================
// 3. SELEÇÃO DE CENÁRIOS E VOZ
// ==========================================
scenarioCards.forEach(card => {
  card.addEventListener('click', () => {
    scenarioCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    currentScenario = card.getAttribute('data-scenario');
    
    addSystemMessage(`Cenário alterado para: <strong>${card.querySelector('strong').innerText}</strong>`);
    
    if (isSessionActive) {
      stopLiveSession();
      setTimeout(() => startLiveSession(), 400);
    }
  });
});

clearChatBtn.addEventListener('click', () => {
  chatMessages.innerHTML = '';
  addSystemMessage('Histórico de conversas limpo.');
});

// ==========================================
// 4. CONTROLE DO BOTÃO PRINCIPAL (MIC)
// ==========================================
micBtn.addEventListener('click', async () => {
  if (!isSessionActive) {
    await startLiveSession();
  } else {
    stopLiveSession();
  }
});

// ==========================================
// 5. CÓDIGO DO PROCESSADOR DE ÁUDIO INLINE (BLOB WORKLET)
// ==========================================
const WORKLET_PROCESSOR_CODE = `
class LiveAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelData = input[0];

    const sampleRateRatio = sampleRate / this.targetSampleRate;
    const outputLength = Math.floor(channelData.length / sampleRateRatio);
    const result = new Int16Array(outputLength);

    let offsetResult = 0;
    let offsetInput = 0;

    while (offsetResult < outputLength) {
      const nextOffsetInput = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < channelData.length; i++) {
        accum += channelData[i];
        count++;
      }
      const sample = count > 0 ? accum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

      offsetResult++;
      offsetInput = nextOffsetInput;
    }

    if (result.length > 0) {
      this.port.postMessage(result.buffer, [result.buffer]);
    }
    return true;
  }
}
registerProcessor('live-audio-processor', LiveAudioProcessor);
`;

// ==========================================
// 6. INICIAR SESSÃO AO VIVO (Gemini Live)
// ==========================================
async function startLiveSession() {
  try {
    updateStatus('connecting', 'Conectando...');
    actionPrompt.innerText = 'Inicializando microfone e conectando ao Gemini...';

    // 1. Inicializa o AudioContext do navegador
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000
    });

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // 2. Solicita permissão do microfone
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 3. Configura o AnalyserNode para visualização em ondas
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyserNode);

    // 4. Conecta ao WebSocket do servidor Node.js
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    socket = new WebSocket(wsUrl);

    // Configura o envio de áudio com fallback ultra-compatível
    let workletLoaded = false;

    if (audioContext.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);
        const workletNode = new AudioWorkletNode(audioContext, 'live-audio-processor');

        workletNode.port.onmessage = (event) => {
          if (socket && socket.readyState === WebSocket.OPEN && isSessionActive) {
            socket.send(event.data);
          }
        };

        sourceNode.connect(workletNode);
        workletLoaded = true;
        console.log('✅ AudioWorklet carregado com sucesso!');
      } catch (err) {
        console.warn('AudioWorklet falhou, ativando modo ScriptProcessor fallback:', err);
      }
    }

    // Se o AudioWorklet não estiver disponível, usamos o ScriptProcessorNode nativo
    if (!workletLoaded) {
      setupScriptProcessor(sourceNode);
    }

    socket.onopen = () => {
      console.log('🔗 WebSocket conectado ao servidor local');
      socket.send(JSON.stringify({
        type: 'start',
        scenario: currentScenario,
        voice: voiceSelect.value,
        apiKey: apiKeyInput.value.trim() || undefined
      }));
    };

    socket.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'status') {
        if (msg.status === 'connected') {
          isSessionActive = true;
          micBtn.classList.add('active');
          updateStatus('connected', 'Conectado');
          actionPrompt.innerText = 'Pode falar em inglês! O Gemini está ouvindo...';
          addSystemMessage(`🎙️ Conversa iniciada no cenário <strong>${msg.scenario}</strong>.`);
        }
      } else if (msg.type === 'audio') {
        updateStatus('speaking', 'Gemini Falando...');
        queueAudioChunk(msg.data);
      } else if (msg.type === 'transcript_user') {
        appendChatMessage('user', msg.text);
      } else if (msg.type === 'transcript_ai') {
        appendChatMessage('ai', msg.text);
      } else if (msg.type === 'interrupted') {
        console.log('⚡ Interrompendo áudio imediatamente!');
        stopAllAudioPlayback();
        updateStatus('connected', 'Ouvindo você...');
      } else if (msg.type === 'turn_complete') {
        updateStatus('connected', 'Ouvindo você...');
      } else if (msg.type === 'error') {
        alert(`Atenção: ${msg.message}`);
        stopLiveSession();
      }
    };

    socket.onerror = (err) => {
      console.error('Erro no WebSocket:', err);
      updateStatus('disconnected', 'Erro na conexão');
    };

    socket.onclose = () => {
      stopLiveSession();
    };

    drawVisualizer();

  } catch (error) {
    console.error('Erro ao iniciar sessão ao vivo:', error);
    alert(`Erro ao acessar microfone ou iniciar conexão: ${error.message}`);
    stopLiveSession();
  }
}

/**
 * Fallback usando ScriptProcessorNode para garantir compatibilidade 100%
 */
function setupScriptProcessor(sourceNode) {
  const bufferSize = 4096;
  scriptProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
    if (!isSessionActive || !socket || socket.readyState !== WebSocket.OPEN) return;

    const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
    const sampleRateRatio = audioContext.sampleRate / 16000;
    const outputLength = Math.floor(inputData.length / sampleRateRatio);
    const result = new Int16Array(outputLength);

    let offsetResult = 0;
    let offsetInput = 0;

    while (offsetResult < outputLength) {
      const nextOffsetInput = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < inputData.length; i++) {
        accum += inputData[i];
        count++;
      }
      const sample = count > 0 ? accum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

      offsetResult++;
      offsetInput = nextOffsetInput;
    }

    if (result.length > 0) {
      socket.send(result.buffer);
    }
  };

  sourceNode.connect(scriptProcessorNode);

  // Conecta em um ganho zero para manter o processador ativo sem gerar eco
  dummyGainNode = audioContext.createGain();
  dummyGainNode.gain.value = 0;
  scriptProcessorNode.connect(dummyGainNode);
  dummyGainNode.connect(audioContext.destination);
}

// ==========================================
// 7. FINALIZAR SESSÃO AO VIVO
// ==========================================
function stopLiveSession() {
  isSessionActive = false;
  micBtn.classList.remove('active');
  updateStatus('disconnected', 'Desconectado');
  actionPrompt.innerText = 'Clique no microfone para iniciar a conversação em inglês!';

  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }));
    }
    socket.close();
    socket = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  stopAllAudioPlayback();

  if (scriptProcessorNode) {
    try { scriptProcessorNode.disconnect(); } catch (e) {}
    scriptProcessorNode = null;
  }

  if (dummyGainNode) {
    try { dummyGainNode.disconnect(); } catch (e) {}
    dummyGainNode = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }

  canvasCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
}

// ==========================================
// 8. GERENCIAMENTO DE ÁUDIO DO GEMINI (PCM 24kHz)
// ==========================================
function queueAudioChunk(base64Data) {
  if (!audioContext || audioContext.state === 'closed') return;

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const audioBuffer = audioContext.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  if (analyserNode) {
    source.connect(analyserNode);
  }

  const currentTime = audioContext.currentTime;
  if (nextStartTime < currentTime) {
    nextStartTime = currentTime;
  }

  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;

  activeAudioSourceNodes.push(source);

  source.onended = () => {
    const index = activeAudioSourceNodes.indexOf(source);
    if (index > -1) {
      activeAudioSourceNodes.splice(index, 1);
    }
  };
}

function stopAllAudioPlayback() {
  activeAudioSourceNodes.forEach(source => {
    try {
      source.stop();
      source.disconnect();
    } catch (e) {}
  });
  activeAudioSourceNodes = [];
  nextStartTime = 0;
}

// ==========================================
// 9. VISUALIZADOR DE ONDAS SONORAS (Canvas)
// ==========================================
function drawVisualizer() {
  if (!isSessionActive || !analyserNode) return;

  requestAnimationFrame(drawVisualizer);

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyserNode.getByteTimeDomainData(dataArray);

  canvasCtx.fillStyle = 'rgba(11, 15, 25, 0.3)';
  canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

  canvasCtx.lineWidth = 2.5;
  canvasCtx.strokeStyle = '#06b6d4';
  canvasCtx.beginPath();

  const sliceWidth = visualizerCanvas.width * 1.0 / bufferLength;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = v * visualizerCanvas.height / 2;

    if (i === 0) {
      canvasCtx.moveTo(x, y);
    } else {
      canvasCtx.lineTo(x, y);
    }

    x += sliceWidth;
  }

  canvasCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height / 2);
  canvasCtx.stroke();
}

// ==========================================
// 10. ATUALIZAÇÃO DE INTERFACE E CHAT (DOM)
// ==========================================
function updateStatus(state, text) {
  statusBadge.className = 'badge';
  if (state === 'connected') {
    statusBadge.classList.add('badge-connected');
  } else if (state === 'speaking') {
    statusBadge.classList.add('badge-speaking');
  } else {
    statusBadge.classList.add('badge-disconnected');
  }
  statusText.innerText = text;
}

function appendChatMessage(sender, text) {
  if (!text || !text.trim()) return;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${sender}`;

  const author = document.createElement('span');
  author.className = 'message-author';
  author.innerText = sender === 'user' ? '👤 Você' : '🤖 Gemini Live';

  const content = document.createElement('div');
  content.innerText = text;

  bubble.appendChild(author);
  bubble.appendChild(content);

  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(htmlText) {
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble system-message';
  bubble.innerHTML = htmlText;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
