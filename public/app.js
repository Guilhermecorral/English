/**
 * ==============================================================================
 * GUIA DE JAVASCRIPT DIDÁTICO: Áudio em Tempo Real, WebSockets e DOM
 * ==============================================================================
 *
 * Conceitos aplicados aqui:
 * 1. Manipulação do DOM (Document Object Model): Interagir com botões, inputs e textos na tela.
 * 2. Web Audio API: Captura do microfone, análise de frequências e reprodução de áudio de alta performance.
 * 3. AudioWorklet: Processamento de áudio em segundo plano (resample para 16kHz PCM).
 * 4. WebSockets: Comunicação bidirecional contínua com o servidor (Node.js -> Gemini Live).
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
let audioWorkletNode = null;
let analyserNode = null;

// Fila de reprodução de áudio do Gemini (24kHz PCM)
let audioPlaybackQueue = [];
let isPlayingAudio = false;
let nextStartTime = 0;
let activeAudioSourceNodes = [];

// ==========================================
// 3. SELEÇÃO DE CENÁRIOS E VOZ
// ==========================================
// Adiciona evento de clique para cada cartão de cenário
scenarioCards.forEach(card => {
  card.addEventListener('click', () => {
    // Remove a classe 'active' de todos os outros cartões
    scenarioCards.forEach(c => c.classList.remove('active'));
    // Adiciona a classe 'active' no cartão clicado
    card.classList.add('active');
    currentScenario = card.getAttribute('data-scenario');
    
    addSystemMessage(`Cenário alterado para: <strong>${card.querySelector('strong').innerText}</strong>`);
    
    // Se a sessão estiver ativa, recomenda reiniciar para aplicar o novo prompt
    if (isSessionActive) {
      stopLiveSession();
      setTimeout(() => startLiveSession(), 400);
    }
  });
});

// Limpar histórico do chat
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
// 5. INICIAR SESSÃO AO VIVO (Gemini Live)
// ==========================================
async function startLiveSession() {
  try {
    updateStatus('connecting', 'Conectando...');
    actionPrompt.innerText = 'Inicializando microfone e conectando ao Gemini...';

    // 1. Inicializa o AudioContext do navegador (necessário para processar e tocar som)
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000 // 24kHz é o sample rate padrão das respostas do Gemini Live
    });

    // 2. Solicita acesso ao microfone do usuário
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 3. Configura o AnalyserNode para alimentar as ondas visuais
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyserNode);

    // 4. Carrega nosso processador de áudio (AudioWorklet)
    await audioContext.audioWorklet.addModule('audio-processor.js');
    audioWorkletNode = new AudioWorkletNode(audioContext, 'live-audio-processor');

    sourceNode.connect(audioWorkletNode);

    // 5. Conecta ao WebSocket do nosso servidor Node.js
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    socket = new WebSocket(wsUrl);

    // Quando o WebSocket abrir com o servidor
    socket.onopen = () => {
      console.log('🔗 WebSocket conectado ao servidor local');

      // Envia a mensagem de inicialização com cenário, voz e chave opcional
      socket.send(JSON.stringify({
        type: 'start',
        scenario: currentScenario,
        voice: voiceSelect.value,
        apiKey: apiKeyInput.value.trim() || undefined
      }));
    };

    // Recebe eventos e áudios do servidor
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
        // Recebeu pedaço de áudio falado pelo Gemini (Base64 PCM 24kHz)
        updateStatus('speaking', 'Gemini Falando...');
        queueAudioChunk(msg.data);
      } else if (msg.type === 'transcript_user') {
        // Transcrição do que o usuário acabou de falar
        appendChatMessage('user', msg.text);
      } else if (msg.type === 'transcript_ai') {
        // Transcrição do que o Gemini respondeu
        appendChatMessage('ai', msg.text);
      } else if (msg.type === 'interrupted') {
        // Usuário interrompeu a IA: para todo o áudio tocando imediatamente
        console.log('Interrompendo áudio imediatamente!');
        stopAllAudioPlayback();
        updateStatus('connected', 'Ouvindo você...');
      } else if (msg.type === 'turn_complete') {
        updateStatus('connected', 'Ouvindo você...');
      } else if (msg.type === 'error') {
        alert(`Atenção: ${msg.message}`);
        stopLiveSession();
      }
    };

    // Quando o AudioWorklet enviar dados de PCM 16kHz do microfone
    audioWorkletNode.port.onmessage = (event) => {
      if (socket && socket.readyState === WebSocket.OPEN && isSessionActive) {
        // Envia os bytes binários do microfone direto via WebSocket
        socket.send(event.data);
      }
    };

    socket.onerror = (err) => {
      console.error('Erro no WebSocket:', err);
      updateStatus('disconnected', 'Erro na conexão');
    };

    socket.onclose = () => {
      stopLiveSession();
    };

    // Inicia a animação das ondas no Canvas
    drawVisualizer();

  } catch (error) {
    console.error('Erro ao iniciar sessão ao vivo:', error);
    alert(`Erro ao acessar microfone ou iniciar conexão: ${error.message}`);
    stopLiveSession();
  }
}

// ==========================================
// 6. FINALIZAR SESSÃO AO VIVO
// ==========================================
function stopLiveSession() {
  isSessionActive = false;
  micBtn.classList.remove('active');
  updateStatus('disconnected', 'Desconectado');
  actionPrompt.innerText = 'Clique no microfone para iniciar a conversação em inglês!';

  // Fecha conexão WebSocket
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }));
    }
    socket.close();
    socket = null;
  }

  // Para o microfone
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  // Para o AudioContext e o áudio que estiver tocando
  stopAllAudioPlayback();
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }

  // Limpa o canvas
  canvasCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
}

// ==========================================
// 7. GERENCIAMENTO DE ÁUDIO DO GEMINI (PCM 24kHz)
// ==========================================
/**
 * Converte base64 de PCM 24kHz 16-bit para AudioBuffer e enfileira para tocar sem pausas
 */
function queueAudioChunk(base64Data) {
  if (!audioContext || audioContext.state === 'closed') return;

  // Decodifica a string Base64 para array de bytes
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Converte bytes Int16 para Float32 (-1.0 a 1.0)
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  // Cria um buffer de áudio nativo do navegador
  const audioBuffer = audioContext.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  // Cria o nó de reprodução (BufferSourceNode)
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  // Se tivermos analyserNode, conectamos a saída nele também para animar as ondas do Gemini
  if (analyserNode) {
    source.connect(analyserNode);
  }

  // Agenda a reprodução contínua (sem cortes entre os blocos recebidos)
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

/**
 * Interrompe qualquer áudio que esteja tocando no momento (quando o usuário começa a falar)
 */
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
// 8. VISUALIZADOR DE ONDAS SONORAS (Canvas)
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
  canvasCtx.strokeStyle = '#06b6d4'; // Ciano neon
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
// 9. ATUALIZAÇÃO DE INTERFACE E CHAT (DOM)
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
  // Rola automaticamente para a última mensagem
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(htmlText) {
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble system-message';
  bubble.innerHTML = htmlText;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
