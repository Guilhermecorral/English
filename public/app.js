/**
 * ==============================================================================
 * GUIA DE JAVASCRIPT DIDÁTICO: Áudio em Tempo Real, WebSockets e DOM
 * ==============================================================================
 *
 * Arquitetura de Áudio:
 * 1. Captura de Microfone: 16kHz PCM Int16 transmitido continuamente via WebSocket.
 * 2. Reprodução de Som: Decodificação contínua de PCM 24kHz do Gemini Live.
 * 3. Streaming de Transcrição: Atualização suave do balão de texto em tempo real.
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
let isSessionStarting = false;
let isAiSpeaking = false;
let currentScenario = 'barista';
let socket = null;

// Áudio Web API
let audioContext = null;
let mediaStream = null;
let audioWorkletNode = null;
let scriptProcessorNode = null;
let dummyGainNode = null;
let analyserNode = null;
let visualizerFrameId = null;

// Fila de reprodução de áudio do Gemini (24kHz PCM)
let nextStartTime = 0;
let activeAudioSourceNodes = [];

// Balões de mensagens ativos para streaming de texto
let currentAiBubble = null;
let currentUserBubble = null;

// ==========================================
// 3. SELEÇÃO DE CENÁRIOS E VOZ
// ==========================================
scenarioCards.forEach(card => {
  card.addEventListener('click', async () => {
    scenarioCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    currentScenario = card.getAttribute('data-scenario');
    
    addSystemMessage(`Cenário alterado para: <strong>${card.querySelector('strong').innerText}</strong>`);
    
    if (isSessionActive) {
      await stopLiveSession();
      await startLiveSession();
    }
  });
});

clearChatBtn.addEventListener('click', () => {
  chatMessages.innerHTML = '';
  currentAiBubble = null;
  currentUserBubble = null;
  addSystemMessage('Histórico de conversas limpo.');
});

// ==========================================
// 4. CONTROLE DO BOTÃO PRINCIPAL (MIC)
// ==========================================
micBtn.addEventListener('click', async () => {
  if (isSessionStarting) return;

  if (!isSessionActive) {
    await startLiveSession();
  } else {
    await stopLiveSession();
  }
});

// ==========================================
// 5. PROCESSAMENTO E ENVIO CONTÍNUO DE ÁUDIO (16kHz PCM)
// ==========================================
function processAndSendMicAudio(inputFloat32Array) {
  if (!isSessionActive || !audioContext || !socket || socket.readyState !== WebSocket.OPEN) return;

  // Converte da taxa do microfone do navegador para 16kHz Int16 PCM (padrão Gemini Live)
  const sampleRateRatio = audioContext.sampleRate / 16000;
  const outputLength = Math.floor(inputFloat32Array.length / sampleRateRatio);
  const pcmData = new Int16Array(outputLength);

  let offsetResult = 0;
  let offsetInput = 0;

  while (offsetResult < outputLength) {
    const nextOffsetInput = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < inputFloat32Array.length; i++) {
      accum += inputFloat32Array[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcmData[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  // Envia o stream de áudio continuamente sem travas
  if (pcmData.length > 0) {
    socket.send(pcmData.buffer);
  }
}

// ==========================================
// 6. INICIAR SESSÃO AO VIVO (Gemini Live)
// ==========================================
async function startLiveSession() {
  if (isSessionActive || isSessionStarting) return;
  isSessionStarting = true;

  try {
    updateStatus('connecting', 'Conectando ao Gemini... ⏳');
    actionPrompt.innerText = 'Inicializando microfone e conectando ao Gemini...';

    // 1. Inicializa o AudioContext
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // 2. Solicita acesso ao microfone com cancelamento de eco nativo do navegador
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 3. Visualizador de ondas
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyserNode);

    isSessionActive = true;
    isAiSpeaking = false;
    micBtn.classList.add('active');
    drawVisualizer();

    // 4. Captura contínua de áudio em blocos de baixa latência
    let workletReady = false;
    if (audioContext.audioWorklet) {
      try {
        await audioContext.audioWorklet.addModule('audio-processor.js');
        audioWorkletNode = new AudioWorkletNode(audioContext, 'live-audio-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1
        });
        audioWorkletNode.port.onmessage = (event) => {
          if (isSessionActive && socket?.readyState === WebSocket.OPEN) {
            socket.send(event.data);
          }
        };
        sourceNode.connect(audioWorkletNode);
        dummyGainNode = audioContext.createGain();
        dummyGainNode.gain.value = 0;
        audioWorkletNode.connect(dummyGainNode);
        dummyGainNode.connect(audioContext.destination);
        workletReady = true;
      } catch (error) {
        console.warn('AudioWorklet indisponível; usando modo compatível:', error);
      }
    }

    if (!workletReady) {
      const bufferSize = 2048;
      scriptProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
      scriptProcessorNode.onaudioprocess = (event) => {
        processAndSendMicAudio(event.inputBuffer.getChannelData(0));
      };

      sourceNode.connect(scriptProcessorNode);
      dummyGainNode = audioContext.createGain();
      dummyGainNode.gain.value = 0;
      scriptProcessorNode.connect(dummyGainNode);
      dummyGainNode.connect(audioContext.destination);
    }

    // 5. Conexão WebSocket com o servidor local
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const sessionSocket = new WebSocket(wsUrl);
    socket = sessionSocket;

    sessionSocket.onopen = () => {
      if (socket !== sessionSocket || !isSessionActive) {
        sessionSocket.close();
        return;
      }

      console.log('🔗 Conectado ao servidor WebSocket local');
      sessionSocket.send(JSON.stringify({
        type: 'start',
        scenario: currentScenario,
        voice: voiceSelect.value,
        apiKey: apiKeyInput.value.trim() || undefined
      }));
    };

    sessionSocket.onmessage = async (event) => {
      if (socket !== sessionSocket) return;

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg.type === 'status') {
        if (msg.status === 'connected') {
          updateStatus('connected', '🟢 Conectado - Ouvindo...');
          actionPrompt.innerText = 'Pode falar em inglês! O Gemini está ouvindo...';
          addSystemMessage(msg.resumed
            ? '♻️ Conexão renovada sem perder o contexto da conversa.'
            : `🎙️ Conectado ao cenário <strong>${msg.scenario}</strong>.`);
        } else if (msg.status === 'connecting') {
          updateStatus('connecting', 'Conectando ao Gemini... ⏳');
        } else if (msg.status === 'reconnecting') {
          stopAllAudioPlayback();
          updateStatus('connecting', `Reconectando... tentativa ${msg.attempt}`);
          actionPrompt.innerText = 'A conexão está sendo renovada automaticamente...';
        } else if (msg.status === 'reconnecting_soon') {
          actionPrompt.innerText = 'O Gemini renovará a conexão em instantes; pode continuar falando.';
        } else if (msg.status === 'listening') {
          updateStatus('connected', '🟢 Microfone ativo - Ouvindo...');
          actionPrompt.innerText = 'Pode falar em inglês! O áudio está chegando ao Gemini.';
        } else if (msg.status === 'closed') {
          addSystemMessage(`🔒 ${msg.message || 'A sessão com o Gemini terminou.'}`);
          await stopLiveSession();
        }
      } else if (msg.type === 'audio') {
        isAiSpeaking = true;
        updateStatus('speaking', '🔊 Gemini Falando...');
        queueAudioChunk(msg.data);
      } else if (msg.type === 'transcript_user') {
        appendStreamText('user', msg.text);
      } else if (msg.type === 'transcript_ai') {
        appendStreamText('ai', msg.text);
      } else if (msg.type === 'interrupted') {
        console.log('⚡ Interrupção de fala');
        stopAllAudioPlayback();
        resetStreamBubbles();
        isAiSpeaking = false;
        updateStatus('connected', '🟢 Ouvindo você...');
      } else if (msg.type === 'turn_complete') {
        resetStreamBubbles();
        isAiSpeaking = false;
        updateStatus('connected', '🟢 Ouvindo você...');
      } else if (msg.type === 'error') {
        alert(`Atenção: ${msg.message}`);
        await stopLiveSession();
      }
    };

    sessionSocket.onerror = (err) => {
      if (socket !== sessionSocket) return;
      console.error('Erro no WebSocket:', err);
      updateStatus('connecting', 'Instabilidade na conexão...');
    };

    sessionSocket.onclose = async () => {
      if (socket !== sessionSocket) return;

      socket = null;
      if (isSessionActive) {
        console.log('Conexão encerrada');
        addSystemMessage('⚠️ A conexão com o servidor local foi encerrada. Clique no microfone para reconectar.');
        await stopLiveSession();
      }
    };

  } catch (error) {
    console.error('Erro ao iniciar sessão ao vivo:', error);
    alert(`Erro ao acessar microfone ou iniciar conexão: ${error.message}`);
    await stopLiveSession();
  } finally {
    isSessionStarting = false;
  }
}

// ==========================================
// 7. FINALIZAR SESSÃO AO VIVO
// ==========================================
async function stopLiveSession() {
  if (!isSessionActive && !isSessionStarting && !socket && !audioContext) return;

  isSessionActive = false;
  isSessionStarting = false;
  isAiSpeaking = false;
  micBtn.classList.remove('active');
  updateStatus('disconnected', 'Desconectado');
  actionPrompt.innerText = 'Clique no microfone para iniciar a conversação em inglês!';
  resetStreamBubbles();

  if (socket) {
    const s = socket;
    socket = null;
    if (s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify({ type: 'stop' }));
    }
    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
      s.close();
    }
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  stopAllAudioPlayback();

  if (audioWorkletNode) {
    try { audioWorkletNode.disconnect(); } catch (e) {}
    audioWorkletNode.port.onmessage = null;
    audioWorkletNode = null;
  }

  if (scriptProcessorNode) {
    scriptProcessorNode.onaudioprocess = null;
    try { scriptProcessorNode.disconnect(); } catch (e) {}
    scriptProcessorNode = null;
  }

  if (dummyGainNode) {
    try { dummyGainNode.disconnect(); } catch (e) {}
    dummyGainNode = null;
  }

  analyserNode = null;

  const contextToClose = audioContext;
  audioContext = null;
  if (contextToClose && contextToClose.state !== 'closed') {
    try { await contextToClose.close(); } catch (e) {}
  }

  if (visualizerFrameId !== null) {
    cancelAnimationFrame(visualizerFrameId);
    visualizerFrameId = null;
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
    if (activeAudioSourceNodes.length === 0) {
      isAiSpeaking = false;
      updateStatus('connected', '🟢 Ouvindo você...');
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
  isAiSpeaking = false;
}

// ==========================================
// 9. VISUALIZADOR DE ONDAS SONORAS (Canvas)
// ==========================================
function drawVisualizer() {
  if (!isSessionActive || !analyserNode) return;

  visualizerFrameId = requestAnimationFrame(drawVisualizer);

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyserNode.getByteTimeDomainData(dataArray);

  canvasCtx.fillStyle = 'rgba(11, 15, 25, 0.3)';
  canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

  canvasCtx.lineWidth = 2.5;
  canvasCtx.strokeStyle = isAiSpeaking ? '#a855f7' : '#06b6d4';
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
// 10. ATUALIZAÇÃO DE INTERFACE E CHAT (STREAMING)
// ==========================================
function updateStatus(state, text) {
  statusBadge.className = 'badge';
  if (state === 'connected') {
    statusBadge.classList.add('badge-connected');
  } else if (state === 'speaking') {
    statusBadge.classList.add('badge-speaking');
  } else if (state === 'connecting') {
    statusBadge.classList.add('badge-connecting');
  } else {
    statusBadge.classList.add('badge-disconnected');
  }
  statusText.innerText = text;
}

function appendStreamText(sender, text) {
  if (!text) return;

  if (sender === 'user') {
    currentAiBubble = null;
    if (!currentUserBubble) {
      currentUserBubble = createMessageBubble('user');
    }
    const contentSpan = currentUserBubble.querySelector('.message-content');
    contentSpan.innerText += text;
  } else if (sender === 'ai') {
    currentUserBubble = null;
    if (!currentAiBubble) {
      currentAiBubble = createMessageBubble('ai');
    }
    const contentSpan = currentAiBubble.querySelector('.message-content');
    contentSpan.innerText += text;
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function createMessageBubble(sender) {
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${sender}`;

  const author = document.createElement('span');
  author.className = 'message-author';
  author.innerText = sender === 'user' ? '👤 Você' : '🤖 Gemini Live';

  const content = document.createElement('div');
  content.className = 'message-content';

  bubble.appendChild(author);
  bubble.appendChild(content);

  chatMessages.appendChild(bubble);
  return bubble;
}

function resetStreamBubbles() {
  currentAiBubble = null;
  currentUserBubble = null;
}

function addSystemMessage(htmlText) {
  resetStreamBubbles();
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble system-message';
  bubble.innerHTML = htmlText;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
