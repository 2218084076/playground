export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopped' | 'error';

export interface RecordingData {
  audioBlob?: Blob;
  audioBuffer?: AudioBuffer;
  duration: number;
  timestamp: number;
}

export interface WebSocketMessage {
  type: 'audio' | 'status' | 'error' | 'connected' | 'disconnected';
  data?: ArrayBuffer | string;
  metadata?: {
    duration?: number;
    sampleRate?: number;
    channels?: number;
    timestamp?: number;
  };
}

export interface WebSocketConfig {
  url: string;
  reconnectAttempts?: number;
  reconnectInterval?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: (message: WebSocketMessage) => void;
}

export class WebSocketService {
  private ws: WebSocket | null = null;
  private config: Required<WebSocketConfig>;
  private reconnectCount = 0;
  private shouldReconnect = true;
  private heartbeatInterval: number | null = null;

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectAttempts: 5,
      reconnectInterval: 3000,
      ...config,
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected to server');
          this.reconnectCount = 0;
          this.startHeartbeat();
          this.config.onOpen?.();
          resolve();
        };

        this.ws.onclose = () => {
          console.log('[WebSocket] Connection closed');
          this.stopHeartbeat();
          this.config.onClose?.();
          this.handleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
          this.config.onError?.(error);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(data: Blob | ArrayBuffer | string) {
    if (data instanceof ArrayBuffer) {
      const message: WebSocketMessage = {
        type: 'audio',
        data,
        metadata: {
          timestamp: Date.now(),
        },
      };
      this.config.onMessage?.(message);
    } else if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as WebSocketMessage;
        this.config.onMessage?.(parsed);
      } catch {
        console.warn('[WebSocket] Failed to parse message:', data);
      }
    }
  }

  private handleReconnect() {
    if (!this.shouldReconnect || this.reconnectCount >= this.config.reconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached or reconnect disabled');
      return;
    }

    this.reconnectCount++;
    console.log(`[WebSocket] Reconnecting... Attempt ${this.reconnectCount}/${this.config.reconnectAttempts}`);

    setTimeout(() => {
      this.connect().catch(console.error);
    }, this.config.reconnectInterval);
  }

  private startHeartbeat() {
    this.heartbeatInterval = window.setInterval(() => {
      this.send({ type: 'status', data: 'ping' });
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  send(message: WebSocketMessage | { type: string; data?: unknown }): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (message.type === 'audio' && message.data instanceof ArrayBuffer) {
        this.ws.send(message.data);
      } else {
        this.ws.send(JSON.stringify(message));
      }
      return true;
    }
    console.warn('[WebSocket] Cannot send message, connection not open');
    return false;
  }

  sendAudioData(audioData: ArrayBuffer, metadata?: RecordingData): boolean {
    return this.send({
      type: 'audio',
      data: audioData,
      metadata: {
        duration: metadata?.duration,
        timestamp: Date.now(),
      },
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get readyState(): number | undefined {
    return this.ws?.readyState;
  }
}

export const createWebSocketService = (config: WebSocketConfig) => {
  return new WebSocketService(config);
};
