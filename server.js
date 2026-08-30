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

// Servir os arquivos estáticos da pasta "public" (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Rota para checar status do servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    hasEnvApiKey: Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)
  });
});

// Prompt de instruções do sistema por cenário para o treino de inglês
const SCENARIOS = {
  barista: {
    title: 'New York Barista',
    systemInstruction: `You are a friendly, cool, and fast-paced barista working in a trendy coffee shop in Brooklyn, New York. 
The user is a customer who wants to practice ordering coffee and chatting in English. 
Speak naturally with a typical friendly American NYC accent and conversational tone.
Gently help them if they hesitate, suggest coffee options (Latte, Cold Brew, Flat White, Pastries), ask for their name for the cup, and keep the conversation engaging and authentic. 
Keep your spoken responses concise and conversational (1 to 3 sentences per turn) so the dialogue flows smoothly.`
  },
  interview: {
    title: 'Job Interview',
    systemInstruction: `You are an encouraging and professional hiring manager conducting a casual job interview in English. 
The user is a candidate practicing English communication for interviews. 
Ask one relevant interview question at a time (e.g., about their background, strengths, problem-solving, or motivations). 
Listen actively, give short positive acknowledgment, and ask a follow-up question. 
Keep your spoken responses concise (1 to 3 sentences) so the conversation is interactive.`
  },
  airport: {
    title: 'Airport & Travel Check-in',
    systemInstruction: `You are an airline customer service agent at JFK Airport in New York. 
The user is a passenger checking in for an international flight and going through security/travel questions. 
Ask for their destination, passport, baggage details, and explain gate information in clear, natural English. 
Keep responses conversational and concise (1 to 3 sentences).`
  },
  tutor: {
    title: 'Friendly English Coach & Friend',
    systemInstruction: `You are an enthusiastic, warm, and supportive English language coach and conversational partner. 
Your goal is to help the user practice speaking English with confidence. 
Talk about everyday topics (hobbies, daily routine, technology, movies, travel). 
If the user makes a noticeable grammatical error or pronunciation slip, gently rephrase it naturally in your response without making them feel self-conscious, and encourage them to keep talking. 
Keep your spoken responses concise and engaging (1 to 3 sentences).`
  }
};

// Gerenciamento de conexões WebSocket com os clientes do navegador
wss.on('connection', (ws) => {
  console.log('🔌 Novo cliente conectado via WebSocket');

  let liveSession = null;
  let isConnectedToGemini = false;

  // Recebe mensagens vindas do navegador
  ws.on('message', async (messageData) => {
    try {
      // Se for JSON (mensagem de controle: setup, switch_scenario, etc.)
      const isJson = typeof messageData === 'string' || (Buffer.isBuffer(messageData) && messageData[0] === 0x7B); // '{'

      if (isJson) {
        const message = JSON.parse(messageData.toString());

        if (message.type === 'start') {
          const apiKey = message.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

          if (!apiKey) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Chave de API não configurada. Defina no .env ou informe na tela.'
            }));
            return;
          }

          const scenarioKey = message.scenario || 'barista';
          const scenarioConfig = SCENARIOS[scenarioKey] || SCENARIOS.barista;
          const voiceName = message.voice || 'Aoede'; // Puck, Charon, Aoede, Fenrir, Kore

          console.log(`🎙️ Iniciando sessão Gemini Live [Cenário: ${scenarioConfig.title}, Voz: ${voiceName}]`);

          // Inicializa o SDK oficial do Google GenAI
          const ai = new GoogleGenAI({ apiKey });

          try {
            // Conecta à Gemini Live API (gemini-3.1-flash-live-preview)
            liveSession = await ai.live.connect({
              model: 'gemini-3.1-flash-live-preview',
              config: {
                responseModalities: ['audio'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voiceName
                    }
                  }
                },
                systemInstruction: {
                  parts: [{ text: scenarioConfig.systemInstruction }]
                }
              },
              callbacks: {
                onopen: () => {
                  console.log('✅ Conectado com sucesso ao Gemini Live!');
                  isConnectedToGemini = true;
                  ws.send(JSON.stringify({
                    type: 'status',
                    status: 'connected',
                    scenario: scenarioConfig.title
                  }));

                  // Dá uma deixa inicial do cenário se for Barista ou outro
                  if (scenarioKey === 'barista') {
                    liveSession.sendRealtimeInput({
                      text: "Greet the customer and ask what they would like to order today."
                    });
                  } else if (scenarioKey === 'interview') {
                    liveSession.sendRealtimeInput({
                      text: "Welcome the candidate warmly and ask them to introduce themselves."
                    });
                  } else if (scenarioKey === 'airport') {
                    liveSession.sendRealtimeInput({
                      text: "Welcome the passenger to the check-in desk and ask for their ticket or destination."
                    });
                  } else {
                    liveSession.sendRealtimeInput({
                      text: "Say a warm hello and ask how their day is going."
                    });
                  }
                },
                onmessage: (response) => {
                  const content = response.serverContent;
                  if (!content) return;

                  // 1. Áudio do modelo (Raw PCM 24kHz)
                  if (content.modelTurn?.parts) {
                    for (const part of content.modelTurn.parts) {
                      if (part.inlineData && part.inlineData.data) {
                        ws.send(JSON.stringify({
                          type: 'audio',
                          data: part.inlineData.data // base64 pcm 24kHz
                        }));
                      }
                    }
                  }

                  // 2. Transcrição do que o usuário falou (STT)
                  if (content.inputTranscription?.text) {
                    ws.send(JSON.stringify({
                      type: 'transcript_user',
                      text: content.inputTranscription.text
                    }));
                  }

                  // 3. Transcrição do que o Gemini respondeu (TTS)
                  if (content.outputTranscription?.text) {
                    ws.send(JSON.stringify({
                      type: 'transcript_ai',
                      text: content.outputTranscription.text
                    }));
                  }

                  // 4. Detecção de interrupção (User começou a falar enquanto Gemini falava)
                  if (content.interrupted) {
                    console.log('⚡ Interrupção detectada! Parando reprodução de áudio.');
                    ws.send(JSON.stringify({ type: 'interrupted' }));
                  }

                  // 5. Fim do turno de resposta
                  if (content.turnComplete) {
                    ws.send(JSON.stringify({ type: 'turn_complete' }));
                  }
                },
                onerror: (err) => {
                  console.error('❌ Erro na sessão Gemini Live:', err);
                  ws.send(JSON.stringify({
                    type: 'error',
                    message: err.message || 'Erro na conexão com a Gemini Live API'
                  }));
                },
                onclose: () => {
                  console.log('🔒 Sessão Gemini Live finalizada');
                  isConnectedToGemini = false;
                  ws.send(JSON.stringify({ type: 'status', status: 'closed' }));
                }
              }
            });
          } catch (connErr) {
            console.error('Erro ao conectar na Live API:', connErr);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Falha ao iniciar Live API: ${connErr.message}`
            }));
          }
        }

        if (message.type === 'stop') {
          if (liveSession) {
            try {
              // Se houver método de fechar sessão
              isConnectedToGemini = false;
              liveSession = null;
            } catch (e) {
              console.error(e);
            }
          }
          ws.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
        }

        if (message.type === 'text_input') {
          // Permite também enviar texto no meio da conversa
          if (liveSession && isConnectedToGemini) {
            liveSession.sendRealtimeInput({ text: message.text });
          }
        }
      } else {
        // Áudio PCM vindo do microfone do usuário (Buffer binário)
        if (liveSession && isConnectedToGemini) {
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
      console.error('Erro ao processar mensagem do WebSocket:', err);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Cliente desconectado');
    isConnectedToGemini = false;
    liveSession = null;
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Gemini Live English Coach rodando em:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`====================================================`);
});
