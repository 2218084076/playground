import React, { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudioFile } from '../../services/transcription';
import './TranscriptionPage.css';

interface TranscriptionLog {
  id: number;
  type: 'info' | 'success' | 'error';
  message: string;
  timestamp: Date;
}

export const TranscriptionPage: React.FC = () => {
  const [mode, setMode] = useState<'file' | 'microphone'>('file');
  const [status, setStatus] = useState<'idle' | 'converting' | 'transcribing' | 'recording' | 'success' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{
    text: string;
    duration_seconds: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TranscriptionLog[]>([]);
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:9007/v1/transcriptions/short?X-User-ID=foo');
  const [recordingTime, setRecordingTime] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const logIdRef = useRef(0);
  const recordingIntervalRef = useRef<number | null>(null);

  // 麦克风相关
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recordingStartRef = useRef<number>(0);

  const addLog = useCallback((type: TranscriptionLog['type'], message: string) => {
    const newLog: TranscriptionLog = {
      id: logIdRef.current++,
      type,
      message,
      timestamp: new Date(),
    };
    setLogs((prev) => [...prev.slice(-49), newLog]);
  }, []);

  // 清理麦克风资源 (不关闭 WebSocket，由 stopMicrophoneRecording 处理)
  const cleanupMicrophone = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  // 清理
  useEffect(() => {
    return () => {
      cleanupMicrophone();
    };
  }, [cleanupMicrophone]);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      // 取消之前的请求
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      setStatus('converting');
      setError(null);
      setResult(null);
      setProgress(0);
      addLog('info', `已选择文件: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);

      try {
        setStatus('transcribing');

        const transcriptionResult = await transcribeAudioFile(file, {
          wsUrl,
          chunkSize: 3200,
          maxDurationSeconds: 55,
          abortSignal: abortControllerRef.current.signal,
          onProgress: (sentBytes, totalBytes, sentSeconds) => {
            const pct = Math.round((sentBytes / totalBytes) * 100);
            setProgress(pct);
            addLog('info', `已发送 ${sentBytes}/${totalBytes} 字节 (${sentSeconds.toFixed(1)}s)`);
          },
          onConnected: () => {
            addLog('info', 'WebSocket 连接已建立');
          },
          onError: (err) => {
            addLog('error', err.message);
            setError(err.message);
            setStatus('error');
          },
        });

        if (transcriptionResult === null) {
          // 被取消
          setStatus('idle');
          addLog('info', '已取消');
          return;
        }

        addLog('info', `转录完成: status=${transcriptionResult.status}, message=${transcriptionResult.message}`);

        if (transcriptionResult.status === 200 && transcriptionResult.data) {
          setResult(transcriptionResult.data);
          setStatus('success');
          addLog('success', `转录结果: ${transcriptionResult.data.text}`);
        } else {
          setError(transcriptionResult.message || 'Transcription failed');
          setStatus('error');
          addLog('error', transcriptionResult.message || 'Transcription failed');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        setError(errMsg);
        setStatus('error');
        addLog('error', errMsg);
      }
    },
    [wsUrl, addLog]
  );

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    setStatus('idle');
    setProgress(0);
    addLog('info', '已取消');
  };

  const handleReset = () => {
    cleanupMicrophone();
    setStatus('idle');
    setResult(null);
    setError(null);
    setProgress(0);
    setRecordingTime(0);
    setLogs([]);
  };

  // 麦克风录音 - 与 test_short_transcription.py 保持一致的发送频率和码率
  // chunk_size = 3200 bytes = 16000Hz * 1ch * 2bytes * 0.1s (每100ms发送一次)
  const CHUNK_SIZE = 3200;
  const SAMPLE_RATE = 16000;
  const CHANNELS = 1;
  const BYTES_PER_SAMPLE = 2;
  const CHUNK_DURATION_MS = 100; // 每100ms发送一次
  const MAX_DURATION = 55; // 最大录音时长

  const startMicrophoneRecording = useCallback(async () => {
    try {
      addLog('info', '正在获取麦克风权限...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // 创建音频上下文 (16kHz)
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // 创建音频处理节点 (缓冲区大小 4096，与 Python 脚本一致)
      const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = scriptNode;

      // 创建 AnalyserNode 用于可视化 (可选)
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.connect(scriptNode);
      scriptNode.connect(audioContext.destination);

      // 音频缓冲区
      let audioChunks: Int16Array[] = [];

      // 创建 WebSocket 连接
      addLog('info', '正在连接 WebSocket...');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        addLog('info', `WebSocket 连接已建立，开始录音 (${SAMPLE_RATE}Hz, ${CHANNELS}ch, ${BYTES_PER_SAMPLE * 8}bit, 每${CHUNK_DURATION_MS}ms发送${CHUNK_SIZE}字节)`);
        setStatus('recording');
        recordingStartRef.current = Date.now();
      };

      ws.onerror = () => {
        addLog('error', 'WebSocket 连接失败');
        setError('WebSocket connection failed');
        setStatus('error');
      };

      ws.onmessage = (event) => {
        try {
          const result =
            typeof event.data === 'string'
              ? JSON.parse(event.data)
              : JSON.parse(new TextDecoder().decode(event.data));
          addLog('info', `收到结果: status=${result.status}, message=${result.message}`);
          if (result.status === 200 && result.data) {
            setResult(result.data);
            setStatus('success');
            addLog('success', `转录结果: ${result.data.text}`);
          } else {
            setError(result.message || 'Transcription failed');
            setStatus('error');
            addLog('error', result.message || 'Transcription failed');
          }
        } catch (e) {
          console.error('解析结果失败:', e);
        }
      };

      ws.onclose = () => {
        addLog('info', 'WebSocket 连接已关闭');
      };

      // 定时器：每100ms发送一次数据
      const sendIntervalId = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (audioChunks.length === 0) return;

        // 计算需要发送的样本数
        const samplesPerChunk = CHUNK_SIZE / BYTES_PER_SAMPLE; // 1600 samples

        // 合并所有音频块
        let totalSamples = 0;
        for (const chunk of audioChunks) {
          totalSamples += chunk.length;
        }

        const combined = new Int16Array(totalSamples);
        let offset = 0;
        for (const chunk of audioChunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }

        // 清空缓冲区
        audioChunks = [];

        // 发送数据
        const sendData = combined.slice(0, samplesPerChunk);
        ws.send(sendData.buffer);

        // 保留多余的数据到下一帧
        if (combined.length > samplesPerChunk) {
          const remaining = combined.slice(samplesPerChunk);
          audioChunks.push(remaining);
        }

        // 更新录音时长
        const elapsed = (Date.now() - recordingStartRef.current) / 1000;
        setRecordingTime(elapsed);
        addLog('info', `已发送音频块: ${sendData.byteLength} 字节 (${elapsed.toFixed(1)}s)`);

        // 检查最大时长
        if (elapsed >= MAX_DURATION) {
          addLog('info', `达到最大时长 ${MAX_DURATION}s，自动停止`);
          stopMicrophoneRecording();
        }
      }, CHUNK_DURATION_MS);

      recordingIntervalRef.current = sendIntervalId;

      // 处理音频数据 - 将数据累积到缓冲区
      scriptNode.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const samples = inputData.length;

        // 转换为 16-bit PCM
        const pcmData = new Int16Array(samples);
        for (let i = 0; i < samples; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        // 累积到缓冲区
        audioChunks.push(pcmData);
      };

    } catch (error) {
      addLog('error', error instanceof Error ? error.message : 'Failed to start recording');
      setError(error instanceof Error ? error.message : 'Failed to start recording');
      setStatus('error');
    }
  }, [wsUrl, addLog]);

  const stopMicrophoneRecording = useCallback(() => {
    const elapsed = (Date.now() - recordingStartRef.current) / 1000;
    addLog('info', `停止录音，时长: ${elapsed.toFixed(2)}s`);

    // 停止定时器
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    // 停止音频处理和麦克风
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // 发送 flush 信号
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      addLog('info', '发送 flush 信号，等待转录结果...');
      wsRef.current.send('flush');
    }

    // 状态会在收到结果时更新
  }, [addLog]);

  const isProcessing = status === 'converting' || status === 'transcribing';
  const isRecording = status === 'recording';

  return (
    <div className="transcription-page">
      <header className="page-header">
        <h1>语音转文字</h1>
        <p className="subtitle">上传音频文件或使用麦克风进行实时转录</p>
      </header>

      <main className="transcription-content">
        <div className="transcription-container">
          {/* 模式切换 */}
          <div className="mode-switch">
            <button
              className={`mode-btn ${mode === 'file' ? 'active' : ''}`}
              onClick={() => setMode('file')}
            >
              上传文件
            </button>
            <button
              className={`mode-btn ${mode === 'microphone' ? 'active' : ''}`}
              onClick={() => setMode('microphone')}
            >
              麦克风录音
            </button>
          </div>

          {/* 设置面板 */}
          <div className="settings-section">
            <label htmlFor="ws-url">WebSocket 地址:</label>
            <input
              id="ws-url"
              type="text"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder="ws://127.0.0.1:9007/v1/transcriptions/short?X-User-ID=foo"
              disabled={isProcessing || isRecording}
            />
          </div>

          {/* 文件上传模式 */}
          {mode === 'file' && (
            <div className="upload-section">
              <label className="file-upload-label">
                <input
                  type="file"
                  accept="audio/*"
                  onChange={handleFileSelect}
                  disabled={isProcessing}
                  className="file-input"
                />
                <div className="file-upload-box">
                  {isProcessing ? (
                    <>
                      <div className="spinner" />
                      <span>{status === 'converting' ? '转换音频格式...' : '转录中...'}</span>
                    </>
                  ) : (
                    <>
                      <span className="upload-icon">🎤</span>
                      <span>点击选择音频文件</span>
                      <span className="upload-hint">支持 wav, mp3, webm 等格式</span>
                    </>
                  )}
                </div>
              </label>

              {/* 进度条 */}
              {isProcessing && (
                <div className="progress-section">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="progress-text">{progress}%</span>
                  <button className="btn-cancel" onClick={handleCancel}>
                    取消
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 麦克风录音模式 */}
          {mode === 'microphone' && (
            <div className="microphone-section">
              <button
                className={`record-btn ${isRecording ? 'recording' : ''}`}
                onClick={isRecording ? stopMicrophoneRecording : startMicrophoneRecording}
                disabled={isProcessing}
              >
                <div className="record-icon">
                  {isRecording ? (
                    <div className="stop-icon" />
                  ) : (
                    <div className="mic-icon" />
                  )}
                </div>
                <span>{isRecording ? '停止录音' : '开始录音'}</span>
              </button>
              {isRecording && (
                <div className="recording-time">
                  <span className="recording-dot" />
                  {recordingTime.toFixed(1)}s / 55s
                </div>
              )}
            </div>
          )}

          {/* 转录结果 */}
          {status === 'success' && result && (
            <div className="result-section">
              <h3>转录结果</h3>
              <div className="result-text">{result.text}</div>
              <div className="result-meta">
                <span>时长: {result.duration_seconds.toFixed(2)}s</span>
              </div>
              <button className="btn-reset" onClick={handleReset}>
                重新开始
              </button>
            </div>
          )}

          {/* 错误信息 */}
          {status === 'error' && error && (
            <div className="error-section">
              <h3>转录失败</h3>
              <p className="error-message">{error}</p>
              <button className="btn-reset" onClick={handleReset}>
                重试
              </button>
            </div>
          )}

          {/* 日志 */}
          {logs.length > 0 && (
            <div className="logs-section">
              <h3>日志</h3>
              <div className="logs-list">
                {logs.map((log) => (
                  <div key={log.id} className={`log-item log-${log.type}`}>
                    <span className="log-time">
                      {log.timestamp.toLocaleTimeString()}
                    </span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
