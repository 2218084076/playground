import React from 'react';

/**
 * 短音频转录服务 (基于 WebSocket)
 */

export interface TranscriptionOptions {
  /** WebSocket URL */
  wsUrl: string;
  /** 每次发送的音频块大小，字节数 (默认: 3200，约 100ms 音频) */
  chunkSize?: number;
  /** 最大发送音频时长（秒），超过则截断 */
  maxDurationSeconds?: number;
  /** 发送进度回调 */
  onProgress?: (sentBytes: number, totalBytes: number, sentSeconds: number) => void;
  /** 连接成功回调 */
  onConnected?: () => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
  /** 中止信号 */
  abortSignal?: AbortSignal;
}

export interface TranscriptionResult {
  status: number;
  message: string;
  data: {
    text: string;
    file_path: string;
    duration_seconds: number;
  } | null;
}

/**
 * 将音频文件转换为 16kHz 单声道 PCM 数据
 */
async function convertAudioTo16kMono(file: File): Promise<Uint8Array> {
  const audioContext = new AudioContext();

  try {
    // 解码音频文件
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const sourceChannels = audioBuffer.numberOfChannels;
    const sourceRate = audioBuffer.sampleRate;
    const sourceLength = audioBuffer.length;

    console.debug(`源音频: ${sourceRate}Hz, ${sourceChannels}ch, ${sourceLength} samples`);

    // 目标参数
    const targetRate = 16000;
    const targetChannels = 1;
    const ratio = sourceRate / targetRate;
    const targetLength = Math.floor(sourceLength / ratio);

    // 创建单声道 Float32Array
    const monoData = new Float32Array(targetLength);

    if (sourceChannels === 2) {
      // 立体声转单声道 (取平均值)
      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);

      for (let i = 0; i < targetLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        monoData[i] = (leftChannel[srcIdx] + rightChannel[srcIdx]) / 2;
      }
    } else {
      // 单声道重采样
      const sourceChannel = audioBuffer.getChannelData(0);
      for (let i = 0; i < targetLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        monoData[i] = sourceChannel[srcIdx];
      }
    }

    // 转换为 16-bit PCM
    const pcmBuffer = new ArrayBuffer(targetLength * 2);
    const pcmView = new DataView(pcmBuffer);
    for (let i = 0; i < targetLength; i++) {
      const sample = Math.max(-1, Math.min(1, monoData[i]));
      pcmView.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    }

    console.debug(
      `转换后音频: ${targetRate}Hz, ${targetChannels}ch, 16bit, ${targetLength / targetRate}s`
    );

    return new Uint8Array(pcmBuffer);
  } finally {
    await audioContext.close();
  }
}

/**
 * 将本地音频文件流式发送给转录接口
 */
export async function transcribeAudioFile(
  file: File,
  options: TranscriptionOptions
): Promise<TranscriptionResult | null> {
  const {
    wsUrl,
    chunkSize = 3200,
    maxDurationSeconds,
    onProgress,
    onConnected,
    onError,
    abortSignal,
  } = options;

  return new Promise(async (resolve, reject) => {
    try {
      // 转换为 16kHz 单声道 PCM
      console.debug('正在转换音频格式...');
      const pcmData = await convertAudioTo16kMono(file);
      const totalBytes = pcmData.length;
      const totalSeconds = totalBytes / (16000 * 2);

      console.debug(`音频转换完成: ${totalBytes} bytes, ${totalSeconds.toFixed(2)}s`);

      // 如果设置了最大时长，超出则截断
      let effectiveBytes = totalBytes;
      if (maxDurationSeconds !== undefined && maxDurationSeconds < totalSeconds) {
        effectiveBytes = Math.floor(maxDurationSeconds * 16000 * 2);
        console.debug(`截断音频到 ${maxDurationSeconds}s`);
      }

      // 建立 WebSocket 连接
      const ws = new WebSocket(wsUrl);

      // 处理中止信号
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          ws.close();
          resolve(null);
        });
      }

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.debug('WebSocket 连接已建立');
        onConnected?.();
      };

      ws.onerror = (event) => {
        console.error('WebSocket 错误:', event);
        onError?.(new Error('WebSocket connection error'));
      };

      ws.onclose = (event) => {
        console.debug(`WebSocket 连接关闭: code=${event.code}, reason=${event.reason}`);
      };

      ws.onmessage = (event) => {
        try {
          let result: TranscriptionResult;
          if (typeof event.data === 'string') {
            result = JSON.parse(event.data);
          } else {
            result = JSON.parse(new TextDecoder().decode(event.data));
          }
          console.debug('转录结果:', result);
          ws.close();
          resolve(result);
        } catch (e) {
          console.error('解析结果失败:', e);
          reject(new Error('Failed to parse result'));
        }
      };

      // 等待连接打开后开始发送
      await new Promise<void>((res, rej) => {
        if (ws.readyState === WebSocket.OPEN) {
          res();
        } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          rej(new Error('Connection closed before opening'));
        } else {
          ws.onopen = () => {
            ws.onopen = null;
            res();
          };
          ws.onerror = () => {
            ws.onerror = null;
            rej(new Error('Connection failed'));
          };
        }
      });

      // 分块发送音频数据
      let offset = 0;
      let chunkNum = 0;

      while (offset < effectiveBytes) {
        // 检查中止信号
        if (abortSignal?.aborted) {
          ws.close();
          resolve(null);
          return;
        }

        const chunk = pcmData.slice(offset, offset + chunkSize);

        // 如果设置了最大时长，超出后停止发送
        if (maxDurationSeconds !== undefined) {
          const sentSeconds = offset / (16000 * 2);
          if (sentSeconds >= maxDurationSeconds) {
            console.debug(`已达到最大时长 ${maxDurationSeconds}s，停止发送`);
            break;
          }
        }

        ws.send(chunk);
        offset += chunk.length;
        chunkNum++;

        if (chunkNum % 50 === 0) {
          console.debug(`已发送 ${chunkNum} 个音频块...`);
        }

        onProgress?.(offset, effectiveBytes, offset / (16000 * 2));

        // 小延迟，避免发送过快
        await new Promise((r) => setTimeout(r, 10));
      }

      console.debug(`音频发送完成，共 ${chunkNum} 个块，时长 ${offset / (16000 * 2).toFixed(2)}s`);

      // 发送 flush 标记结束
      ws.send('flush');
    } catch (error) {
      console.error('错误:', error);
      onError?.(error as Error);
      reject(error);
    }
  });
}

/**
 * 麦克风实时录音并转录
 */
export function useMicrophoneTranscription(options: {
  /** WebSocket URL */
  wsUrl: string;
  /** 最大录音时长（秒） */
  maxDurationSeconds?: number;
  /** 进度回调 (实时秒数) */
  onProgress?: (seconds: number) => void;
  /** 转录结果回调 */
  onResult?: (result: TranscriptionResult) => void;
  /** 错误回调 */
  onError?: (error: Error) => void;
}) {
  const { wsUrl, maxDurationSeconds = 55, onProgress, onResult, onError } = options;

  const audioContextRef = React.useRef<AudioContext | null>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);
  const processorRef = React.useRef<ScriptProcessorNode | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const startTimeRef = React.useRef<number>(0);
  const intervalRef = React.useRef<number | null>(null);

  const start = React.useCallback(async () => {
    try {
      // 获取麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // 创建音频上下文
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      // 创建音频处理节点
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // 创建 WebSocket 连接
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      await new Promise<void>((res, rej) => {
        ws.onopen = () => {
          console.debug('Microphone WebSocket 连接已建立');
          res();
        };
        ws.onerror = () => rej(new Error('Connection failed'));
      });

      startTimeRef.current = Date.now();

      // 定时更新进度
      intervalRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        onProgress?.(elapsed);

        // 检查最大时长
        if (maxDurationSeconds && elapsed >= maxDurationSeconds) {
          stop();
        }
      }, 100);

      // 处理音频数据
      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const inputData = event.inputBuffer.getChannelData(0);
        const outputData = new Int16Array(inputData.length);

        // 转换为 16-bit PCM
        for (let i = 0; i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i]));
          outputData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        ws.send(outputData.buffer);
      };

      // 处理转录结果
      ws.onmessage = (event) => {
        try {
          const result =
            typeof event.data === 'string'
              ? JSON.parse(event.data)
              : JSON.parse(new TextDecoder().decode(event.data));
          onResult?.(result);
        } catch (e) {
          console.error('解析结果失败:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket 错误:', e);
        onError?.(new Error('WebSocket connection error'));
      };

      // 连接源和处理器
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('Failed to start recording'));
    }
  }, [wsUrl, maxDurationSeconds, onProgress, onResult, onError]);

  const stop = React.useCallback(() => {
    // 停止音频处理
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // 停止麦克风
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // 关闭音频上下文
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // 发送 flush 并关闭 WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send('flush');
      wsRef.current.close();
      wsRef.current = null;
    }

    // 清除定时器
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // 清理
  React.useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { start, stop };
}

// 需要引入 React
import React from 'react';
