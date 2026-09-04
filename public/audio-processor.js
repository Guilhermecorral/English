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
    this.targetSampleRate = 16000;
    this.samplesPerChunk = 640;
    this.pendingInput = new Float32Array(0);
    this.readPosition = 0;
    this.outputChunk = new Int16Array(this.samplesPerChunk);
    this.outputOffset = 0;
  }

  /**
   * O método process é chamado continuamente pelo navegador com pedaços do áudio capturado
   * @param {Float32Array[][]} inputs - Arrays com os canais de áudio de entrada
   */
  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    // Canal mono (primeiro canal do microfone)
    const channelData = input[0];
    const outputChannel = outputs?.[0]?.[0];

    if (outputChannel) {
      outputChannel.set(channelData.subarray(0, outputChannel.length));
    }

    const sampleRateRatio = sampleRate / this.targetSampleRate;
    this.downsampleAndSend(channelData, sampleRateRatio);

    return true;
  }

  /**
   * Faz a interpolação linear para reamostrar e converte de Float32 para Int16 PCM
   */
  downsampleAndSend(inputData, ratio) {
    const combinedInput = new Float32Array(this.pendingInput.length + inputData.length);
    combinedInput.set(this.pendingInput);
    combinedInput.set(inputData, this.pendingInput.length);

    while (this.readPosition + ratio <= combinedInput.length) {
      const offsetInput = Math.floor(this.readPosition);
      const nextOffsetInput = Math.max(offsetInput + 1, Math.floor(this.readPosition + ratio));
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < combinedInput.length; i++) {
        accum += combinedInput[i];
        count++;
      }

      const sample = count > 0 ? accum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outputChunk[this.outputOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      this.outputOffset++;
      this.readPosition += ratio;

      if (this.outputOffset === this.samplesPerChunk) {
        const completedChunk = this.outputChunk;
        this.outputChunk = new Int16Array(this.samplesPerChunk);
        this.outputOffset = 0;
        this.port.postMessage(completedChunk.buffer, [completedChunk.buffer]);
      }
    }

    const consumedSamples = Math.floor(this.readPosition);
    this.pendingInput = combinedInput.slice(consumedSamples);
    this.readPosition -= consumedSamples;
  }
}

// Registra o processador no sistema de áudio do navegador
registerProcessor('live-audio-processor', LiveAudioProcessor);
