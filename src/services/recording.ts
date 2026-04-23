export interface MediaRecorderConfig {
  mimeType?: string;
  audioBitsPerSecond?: number;
  onDataAvailable?: (blob: Blob) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onStop?: (blob: Blob, duration: number) => void;
  onStatusChange?: (status: RecordingStatus) => void;
}

export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopped' | 'error';

export class RecordingService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;
  private status: RecordingStatus = 'idle';
  private config: MediaRecorderConfig;
  private onStatusChange?: (status: RecordingStatus) => void;
  private onAudioData?: (audioData: ArrayBuffer) => void;
  private processor: ScriptProcessorNode | null = null;

  constructor(config: MediaRecorderConfig = {}) {
    this.config = {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000,
      ...config,
    };
    this.onStatusChange = config.onStatusChange;
  }

  async requestPermission(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        return { success: false, error: '您的浏览器不支持标签页音频捕获' };
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: true
      });
      
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach(track => track.stop());
        return { success: false, error: '未选择任何标签页或该标签页没有音频' };
      }

      stream.getTracks().forEach(track => track.stop());
      return { success: true };
    } catch (error: any) {
      console.error('[Recording] Permission denied:', error);
      if (error.name === 'NotAllowedError') {
        return { success: false, error: '用户取消了选择或拒绝了权限' };
      }
      if (error.name === 'NotFoundError') {
        return { success: false, error: '未找到可用的音频源' };
      }
      return { success: false, error: error.message || '获取权限失败' };
    }
  }

  async start(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: {
          displaySurface: 'browser',
        }
      });

      const audioTrack = this.stream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error('No audio track found. Please select a tab with audio.');
      }

      this.audioContext = new AudioContext({ sampleRate: 48000 });
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);

      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.processor.onaudioprocess = (event) => {
        if (this.status === 'recording' && this.onAudioData) {
          const inputData = event.inputBuffer;
          const audioData = this.convertAudioBufferToWav(inputData);
          this.onAudioData(audioData);
        }
      };

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: this.config.mimeType,
        audioBitsPerSecond: this.config.audioBitsPerSecond,
      });

      this.chunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
          this.config.onDataAvailable?.(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.config.mimeType });
        const duration = (Date.now() - this.startTime) / 1000;
        this.config.onStop?.(blob, duration);
        this.cleanup();
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('[Recording] MediaRecorder error:', event);
        this.setStatus('error');
        this.config.onError?.(new Error('MediaRecorder error'));
      };

      this.mediaRecorder.start(1000);
      this.startTime = Date.now();
      this.setStatus('recording');
      this.config.onStart?.();

      return true;
    } catch (error) {
      console.error('[Recording] Failed to start recording:', error);
      this.setStatus('error');
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private convertAudioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const data = buffer.getChannelData(0);
    const samples = data.length;
    const dataSize = samples * blockAlign;
    const bufferSize = 44 + dataSize;

    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples; i++) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }

    return arrayBuffer;
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  pause() {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.pause();
      this.setStatus('paused');
    }
  }

  resume() {
    if (this.mediaRecorder?.state === 'paused') {
      this.mediaRecorder.resume();
      this.setStatus('recording');
    }
  }

  stop(): Blob | null {
    if (this.mediaRecorder?.state !== 'inactive') {
      this.mediaRecorder?.stop();
      this.setStatus('stopped');
      
      if (this.chunks.length > 0) {
        return new Blob(this.chunks, { type: this.config.mimeType });
      }
    }
    return null;
  }

  private cleanup() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
  }

  private setStatus(status: RecordingStatus) {
    this.status = status;
    this.onStatusChange?.(status);
  }

  getStatus(): RecordingStatus {
    return this.status;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getDuration(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  setOnAudioData(callback: (audioData: ArrayBuffer) => void) {
    this.onAudioData = callback;
  }

  downloadRecording(blob: Blob, filename: string = 'recording.webm') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

export const createRecordingService = (config?: MediaRecorderConfig) => {
  return new RecordingService(config);
};
