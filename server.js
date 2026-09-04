import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Servir os arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Rota de status da API
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    hasEnvApiKey: Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)
  });
});

// Prompts de instrução de cada cenário de treino de inglês
const SCENARIOS = {
  barista: {
    title: 'New York Barista',
    initialPrompt: "Greet the customer in a cool NYC coffee shop style in 1 or 2 short sentences and ask what they would like to drink.",
    systemInstruction: `You are a friendly, cool, and fast-paced barista working in a trendy coffee shop in Brooklyn, New York. 
The user is a customer who wants to practice ordering coffee and chatting in English. 
Speak naturally with a typical friendly American NYC accent and conversational tone.
Gently help them if they hesitate, suggest coffee options (Latte, Cold Brew, Flat White, Pastries), ask for their name for the cup, and keep the conversation engaging and authentic. 
Keep your spoken responses concise and conversational (1 to 3 sentences per turn) so the dialogue flows smoothly.`
  },
  interview: {
    title: 'Job Interview',
    initialPrompt: "Welcome the candidate warmly in 1 or 2 short sentences and ask them to introduce themselves.",
    systemInstruction: `You are an encouraging and professional hiring manager conducting a casual job interview in English. 
The user is a candidate practicing English communication for interviews. 
Ask one relevant interview question at a time (e.g., about their background, strengths, problem-solving, or motivations). 
Listen actively, give short positive acknowledgment, and ask a follow-up question. 
Keep your spoken responses concise (1 to 3 sentences) so the conversation is interactive.`
  },
  airport: {
    title: 'Airport & Travel Check-in',
    initialPrompt: "Welcome the passenger to the JFK check-in desk in 1 or 2 short sentences and ask for their destination or passport.",
    systemInstruction: `You are an airline customer service agent at JFK Airport in New York. 
The user is a passenger checking in for an international flight and going through security/travel questions. 
Ask for their destination, passport, baggage details, and explain gate information in clear, natural English. 
Keep responses conversational and concise (1 to 3 sentences).`
  },
  tutor: {
    title: 'Friendly English Coach & Friend',
    initialPrompt: "Say a warm hello in 1 or 2 short sentences and ask how their day is going.",
    systemInstruction: `You are an enthusiastic, warm, and supportive English language coach and conversational partner. 
Your goal is to help the user practice speaking English with confidence. 
Talk about everyday topics (hobbies, daily routine, technology, movies, travel). 
If the user makes a noticeable grammatical error or pronunciation slip, gently rephrase it naturally in your response without making them feel self-conscious, and encourage them to keep talking. 
Keep your spoken responses concise and engaging (1 to 3 sentences).`
  }
};

// Gerenciamento de conexões WebSocket com o navegador
wss.on('connection', (ws) => {
  console.log('🔌 Novo cliente conectado via WebSocket');

  let liveSession = null;
  let isConnectedToGemini = false;
  let shouldKeepSession = false;
  let connectionId = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let resumptionHandle = null;
  let sessionSettings = null;
  let greetingSent = false;
  let lastConnectionError = '';
  let receivedAudioForSession = false;

  const sendToBrowser = (payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeLiveSession = () => {
    connectionId++;
    isConnectedToGemini = false;

    const sessionToClose = liveSession;
    liveSession = null;

    if (sessionToClose) {
      try {
        sessionToClose.close();
      } catch (error) {
        console.warn('Não foi possível fechar a sessão Gemini:', error.message);
      }
    }
  };

  const stopGeminiSession = () => {
    shouldKeepSession = false;
    clearReconnectTimer();
    closeLiveSession();
    reconnectAttempts = 0;
    resumptionHandle = null;
    sessionSettings = null;
    greetingSent = false;
    receivedAudioForSession = false;
  };

  const scheduleReconnect = (reason = '') => {
    if (!shouldKeepSession || ws.readyState !== WebSocket.OPEN || reconnectTimer) return;

    if (reconnectAttempts >= 6) {
      shouldKeepSession = false;
      console.error('❌ Não foi possível restabelecer a sessão Gemini:', reason);
      sendToBrowser({
        type: 'status',
        status: 'closed',
        message: 'A sessão com o Gemini terminou. Clique no microfone para tentar novamente.'
      });
      return;
    }

    const delay = Math.min(750 * (2 ** reconnectAttempts), 6000);
    reconnectAttempts++;
    sendToBrowser({
      type: 'status',
      status: 'reconnecting',
      attempt: reconnectAttempts
    });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToGemini();
    }, delay);
  };

  const connectToGemini = async () => {
    if (!shouldKeepSession || !sessionSettings || ws.readyState !== WebSocket.OPEN) return;

    clearReconnectTimer();
    isConnectedToGemini = false;
    lastConnectionError = '';

    const currentConnectionId = ++connectionId;
    const handleForAttempt = resumptionHandle;
    let setupCompleted = false;
    let connectionClosed = false;

    const activateSession = () => {
      if (
        !setupCompleted ||
        currentConnectionId !== connectionId ||
        connectionClosed ||
        !liveSession ||
        isConnectedToGemini
      ) return;

      isConnectedToGemini = true;
      reconnectAttempts = 0;
      console.log(handleForAttempt
        ? '✅ Sessão Gemini Live retomada com sucesso.'
        : '✅ Gemini Live Setup completo! Pronto para conversar.');

      sendToBrowser({
        type: 'status',
        status: 'connected',
        scenario: sessionSettings.scenarioConfig.title,
        resumed: Boolean(handleForAttempt)
      });

      if (!greetingSent) {
        greetingSent = true;
        liveSession.sendRealtimeInput({
          text: sessionSettings.scenarioConfig.initialPrompt
        });
      }
    };

    try {
      const nextSession = await sessionSettings.ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: sessionSettings.voiceName
              }
            }
          },
          systemInstruction: {
            parts: [{ text: sessionSettings.scenarioConfig.systemInstruction }]
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: {
            slidingWindow: {}
          },
          sessionResumption: {
            handle: handleForAttempt || undefined
          }
        },
        callbacks: {
          onopen: () => {
            if (currentConnectionId === connectionId) {
              console.log('🔗 WebSocket conectado ao Google Gemini');
            }
          },
          onmessage: (response) => {
            if (currentConnectionId !== connectionId) return;

            const resumptionUpdate = response.sessionResumptionUpdate;
            if (resumptionUpdate?.resumable && resumptionUpdate.newHandle) {
              resumptionHandle = resumptionUpdate.newHandle;
            }

            if (response.goAway) {
              console.log(`♻️ Gemini solicitou renovação da conexão em ${response.goAway.timeLeft || 'breve'}.`);
              sendToBrowser({
                type: 'status',
                status: 'reconnecting_soon',
                timeLeft: response.goAway.timeLeft
              });
            }

            if (response.setupComplete) {
              setupCompleted = true;
              activateSession();
              return;
            }

            const content = response.serverContent;
            if (!content) return;

            if (content.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  sendToBrowser({
                    type: 'audio',
                    data: part.inlineData.data
                  });
                }
              }
            }

            if (content.inputTranscription?.text) {
              sendToBrowser({
                type: 'transcript_user',
                text: content.inputTranscription.text
              });
            }

            if (content.outputTranscription?.text) {
              sendToBrowser({
                type: 'transcript_ai',
                text: content.outputTranscription.text
              });
            }

            if (content.interrupted) {
              console.log('⚡ Usuário interrompeu a fala da IA!');
              sendToBrowser({ type: 'interrupted' });
            }

            if (content.turnComplete) {
              sendToBrowser({ type: 'turn_complete' });
            }
          },
          onerror: (error) => {
            if (currentConnectionId !== connectionId) return;
            lastConnectionError = error?.message || error?.error?.message || 'Erro na conexão com a Gemini Live API';
            console.error('❌ Erro na sessão Gemini Live:', lastConnectionError);
          },
          onclose: (event) => {
            if (currentConnectionId !== connectionId) return;

            connectionClosed = true;
            console.log(`🔒 Conexão Gemini Live finalizada${event?.reason ? `: ${event.reason}` : ''}`);
            isConnectedToGemini = false;
            liveSession = null;

            if (handleForAttempt && !setupCompleted) {
              resumptionHandle = null;
            }

            scheduleReconnect(event?.reason || lastConnectionError);
          }
        }
      });

      if (currentConnectionId !== connectionId || !shouldKeepSession || connectionClosed) {
        nextSession.close();
        return;
      }

      liveSession = nextSession;
      activateSession();
    } catch (error) {
      if (currentConnectionId !== connectionId) return;

      liveSession = null;
      isConnectedToGemini = false;
      lastConnectionError = error.message || 'Falha ao iniciar Live API';
      console.error('Erro ao conectar na Live API:', error);

      if (handleForAttempt) {
        resumptionHandle = null;
      }

      scheduleReconnect(lastConnectionError);
    }
  };

  // Heartbeat para manter a conexão WebSocket sempre ativa sem quedas por inatividade
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 20000);

  ws.on('message', async (messageData, isBinary) => {
    try {
      if (!isBinary) {
        let message;
        try {
          message = JSON.parse(messageData.toString());
        } catch (parseErr) {
          return;
        }

        if (message.type === 'start') {
          const apiKey = message.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

          if (!apiKey) {
            sendToBrowser({
              type: 'error',
              message: 'Chave de API não encontrada! Adicione ao .env ou cole no campo na tela.'
            });
            return;
          }

          const scenarioKey = message.scenario || 'barista';
          const scenarioConfig = SCENARIOS[scenarioKey] || SCENARIOS.barista;
          const voiceName = message.voice || 'Aoede';

          console.log(`🎙️ Iniciando sessão Gemini Live [Cenário: ${scenarioConfig.title}, Voz: ${voiceName}]`);

          stopGeminiSession();
          shouldKeepSession = true;
          sessionSettings = {
            ai: new GoogleGenAI({ apiKey }),
            scenarioConfig,
            voiceName
          };
          sendToBrowser({ type: 'status', status: 'connecting' });
          await connectToGemini();
        }

        if (message.type === 'stop') {
          stopGeminiSession();
          sendToBrowser({ type: 'status', status: 'disconnected' });
        }

        if (message.type === 'text_input') {
          if (liveSession && isConnectedToGemini) {
            liveSession.sendRealtimeInput({ text: message.text });
          }
        }
      } else {
        // Envio contínuo de PCM 16kHz do microfone do usuário
        if (liveSession && isConnectedToGemini) {
          if (!receivedAudioForSession) {
            receivedAudioForSession = true;
            console.log('🎤 Fluxo de áudio do microfone recebido.');
            sendToBrowser({ type: 'status', status: 'listening' });
          }

          const base64Audio = messageData.toString('base64');
          liveSession.sendRealtimeInput({
            audio: {
              data: base64Audio,
              mimeType: 'audio/pcm;rate=16000'
            }
          });
        }
      }
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Cliente desconectado do WebSocket');
    clearInterval(pingInterval);
    stopGeminiSession();
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Gemini Live English Coach rodando em:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`====================================================`);
});
