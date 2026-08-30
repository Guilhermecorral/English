/**
 * ==============================================================================
 * AudioWorkletProcessor: Processamento de Áudio em Tempo Real no Navegador
 * ==============================================================================
 * 
 * O que este arquivo faz?
 * 1. É executado em uma thread separada de áudio no navegador (para não travar a interface gráfica).
 * 2. Recebe o áudio bruto do microfone (valores Float32 entre -1.0 e 1.0).
 * 3. Faz o "Downsampling" (converte da taxa do seu microfone, ex: 48kHz/44.1kHz, para 16kHz).
 * 4. Converte os valores para inteiros de 16 bits (Int16 PCM), que é o formato esperado pela Gemini Live API.
 * 5. Envia os pacotes convertidos para o arquivo principal (app.js) via postMessage().
 */

class LiveAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetSampleRate = 16000; // Taxa exigida pela Gemini Live API (16kHz)
  }

  /**
   * O método process é chamado continuamente pelo navegador com pedaços do áudio capturado
   * @param {Float32Array[][]} inputs - Arrays com os canais de áudio de entrada
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    // Canal mono (primeiro canal do microfone)
    const channelData = input[0];

    // Se o sampleRate nativo do navegador for diferente de 16000, calculamos o ratio de reamostragem
    const sampleRateRatio = sampleRate / this.targetSampleRate;
    
    // Converte Float32 (-1.0 a 1.0) para Int16 (-32768 a 32767) com downsampling
    const pcmData = this.downsampleAndConvertToPCM(channelData, sampleRateRatio);

    if (pcmData.length > 0) {
      // Envia o array de bytes (Int16) para a thread principal (app.js)
      this.port.postMessage(pcmData.buffer, [pcmData.buffer]);
    }

    return true;
  }

  /**
   * Faz a interpolação linear para reamostrar e converte de Float32 para Int16 PCM
   */
  downsampleAndConvertToPCM(inputData, ratio) {
    const outputLength = Math.floor(inputData.length / ratio);
    const result = new Int16Array(outputLength);

    let offsetResult = 0;
    let offsetInput = 0;

    while (offsetResult < outputLength) {
      const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
      
      // Média simples das amostras para evitar ruído de alias
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < inputData.length; i++) {
        accum += inputData[i];
        count++;
      }

      const sample = count > 0 ? accum / count : 0;
      // Garante que o valor fique entre -1.0 e 1.0 e converte para Int16 (-32768 a 32767)
      const clamped = Math.max(-1, Math.min(1, sample));
      result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

      offsetResult++;
      offsetInput = nextOffsetInput;
    }

    return result;
  }
}

// Registra o processador no sistema de áudio do navegador
registerProcessor('live-audio-processor', LiveAudioProcessor);
