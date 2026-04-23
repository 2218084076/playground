import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Link} from 'react-router-dom';
import {Header} from '../../components/Header';
import {RecordingService, RecordingStatus} from '../../services/recording';
import {WebSocketService} from '../../services/websocket';
import './RecordingPage.css';

interface RecordingLog {
  id: number;
  type: 'sent' | 'received' | 'status' | 'error';
  message: string;
  timestamp: Date;
}

export const RecordingPage: React.FC = () => {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [wsUrl, setWsUrl] = useState('ws://localhost:8080/audio');
  const [showSettings, setShowSettings] = useState(false);
  const [logs, setLogs] = useState<RecordingLog[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);

  const recordingServiceRef = useRef<RecordingService | null>(null);
  const wsServiceRef = useRef<WebSocketService | null>(null);
  const timerRef = useRef<number | null>(null);
  const logIdRef = useRef(0);

  const addLog = useCallback((type: RecordingLog['type'], message: string) => {
    const newLog: RecordingLog = {
      id: logIdRef.current++,
      type,
      message,
      timestamp: new Date(),
    };
    setLogs(prev => [...prev.slice(-99), newLog]);
  }, []);

  useEffect(() => {
    recordingServiceRef.current = new RecordingService({
      onStatusChange: setStatus,
      onError: (error) => addLog('error', error.message),
      onStart: () => {
        addLog('status', '开始录制');
        startTimer();
      },
      onStop: (blob, dur) => {
        addLog('status', `录制结束，时长: ${dur.toFixed(2)}秒`);
        stopTimer();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
      },
    });

    recordingServiceRef.current.setOnAudioData((audioData: any) => {
      if (wsServiceRef.current?.isConnected) {
        wsServiceRef.current.sendAudioData(audioData, {
          duration: duration,
          timestamp: Date.now(),
        });
        addLog('sent', `发送音频数据: ${(audioData.byteLength / 1024).toFixed(2)} KB`);
      }
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recordingServiceRef.current?.stop();
      wsServiceRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    const analyser = recordingServiceRef.current?.getAnalyser();
    if (analyser && status === 'recording') {
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setAudioLevel(average / 255);
        if (status === 'recording') {
          requestAnimationFrame(updateLevel);
        }
      };
      updateLevel();
    } else {
      setAudioLevel(0);
    }
  }, [status]);

  const startTimer = () => {
    timerRef.current = window.setInterval(() => {
      setDuration(prev => prev + 0.1);
    }, 100);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleConnect = async () => {
    try {
      addLog('status', `正在连接到: ${wsUrl}`);

      wsServiceRef.current = new WebSocketService({
        url: wsUrl,
        onOpen: () => {
          setIsConnected(true);
          addLog('status', 'WebSocket 连接成功');
        },
        onClose: () => {
          setIsConnected(false);
          addLog('status', 'WebSocket 连接关闭');
        },
        onError: (error) => {
          addLog('error', `WebSocket 错误: ${error.type}`);
        },
        onMessage: (message) => {
          addLog('received', `收到消息: ${JSON.stringify(message)}`);
        },
      });

      await wsServiceRef.current.connect();
    } catch (error) {
      addLog('error', `连接失败: ${error}`);
    }
  };

  const handleDisconnect = () => {
    wsServiceRef.current?.disconnect();
    setIsConnected(false);
    addLog('status', '已断开 WebSocket 连接');
  };

  const handleStartRecording = async () => {
    const result = await recordingServiceRef.current?.requestPermission();
    if (!result?.success) {
      addLog('error', result?.error || '无法获取标签页音频权限');
      return;
    }
    const success = await recordingServiceRef.current?.start();
    if (!success) {
      addLog('error', '启动录制失败');
    }
  };

  const handleStopRecording = () => {
    recordingServiceRef.current?.stop();
    setDuration(0);
  };

  const handlePauseResume = () => {
    if (status === 'recording') {
      recordingServiceRef.current?.pause();
      stopTimer();
      addLog('status', '暂停录制');
    } else if (status === 'paused') {
      recordingServiceRef.current?.resume();
      startTimer();
      addLog('status', '继续录制');
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  const getStatusColor = () => {
    switch (status) {
      case 'recording':
        return '#ff3b30';
      case 'paused':
        return '#ff9500';
      case 'stopped':
        return '#30d158';
      default:
        return '#8e8e93';
    }
  };

  return (
    <div className="recording-page">
      <Header isRecording={status === 'recording'} recordingDuration={duration}/>

      <main className="recording-content">
        <div className="recording-container">
          <div className="recording-card">
            <div className="card-header">
              <h2>🎙️ 标签页音频录制</h2>
              <div className="header-actions">
                <Link to="/transcribe" className="nav-link">
                  语音转文字
                </Link>
                <button
                  className="settings-btn"
                  onClick={() => setShowSettings(!showSettings)}
                >
                  ⚙️
                </button>
              </div>
            </div>

            {showSettings && (
              <div className="settings-panel">
                <div className="setting-item">
                  <label>WebSocket 地址:</label>
                  <input
                    type="text"
                    value={wsUrl}
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder="ws://localhost:8080/audio"
                  />
                </div>
                <div className="setting-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleConnect}
                    disabled={isConnected}
                  >
                    连接
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={handleDisconnect}
                    disabled={!isConnected}
                  >
                    断开
                  </button>
                </div>
                <div className="connection-info">
                  连接状态:
                  <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
                    {isConnected ? '已连接' : '未连接'}
                  </span>
                </div>
              </div>
            )}

            <div className="visualizer">
              <div
                className="audio-bars"
                style={{
                  '--audio-level': audioLevel,
                } as React.CSSProperties}
              >
                {[...Array(20)].map((_, i) => (
                  <div
                    key={i}
                    className="bar"
                    style={{
                      animationDelay: `${i * 0.05}s`,
                      height: status === 'recording' ? `${20 + Math.random() * 80}%` : '10%',
                    }}
                  />
                ))}
              </div>
              <div className="time-display" style={{color: getStatusColor()}}>
                {formatTime(duration)}
              </div>
              <div className="status-display">
                <span
                  className="status-indicator"
                  style={{backgroundColor: getStatusColor()}}
                />
                {status === 'idle' && '准备就绪'}
                {status === 'recording' && '正在录制...'}
                {status === 'paused' && '已暂停'}
                {status === 'stopped' && '录制完成'}
                {status === 'error' && '发生错误'}
              </div>
            </div>

            <div className="controls">
              {status === 'idle' && (
                <button
                  className="control-btn record-btn"
                  onClick={handleStartRecording}
                >
                  <span className="btn-icon">⏺️</span>
                  开始录制
                </button>
              )}

              {status === 'recording' && (
                <>
                  <button
                    className="control-btn pause-btn"
                    onClick={handlePauseResume}
                  >
                    <span className="btn-icon">⏸️</span>
                    暂停
                  </button>
                  <button
                    className="control-btn stop-btn"
                    onClick={handleStopRecording}
                  >
                    <span className="btn-icon">⏹️</span>
                    停止
                  </button>
                </>
              )}

              {status === 'paused' && (
                <>
                  <button
                    className="control-btn resume-btn"
                    onClick={handlePauseResume}
                  >
                    <span className="btn-icon">▶️</span>
                    继续
                  </button>
                  <button
                    className="control-btn stop-btn"
                    onClick={handleStopRecording}
                  >
                    <span className="btn-icon">⏹️</span>
                    停止
                  </button>
                </>
              )}

              {(status === 'stopped' || status === 'error') && (
                <button
                  className="control-btn record-btn"
                  onClick={handleStartRecording}
                >
                  <span className="btn-icon">⏺️</span>
                  重新录制
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};