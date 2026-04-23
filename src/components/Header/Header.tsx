import React from "react";
import './Header.css';

interface HeaderProps {
  isRecording?: boolean;
  recordingDuration?: number;
}

const Header: React.FC<HeaderProps> = ({isRecording = false, recordingDuration = 0}) => {

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-left">
          <h1 className="app-title">
            <span className="logo-icon">🎙️</span>
            标签页音频录制
          </h1>
        </div>

        <div className="header-right">
          {isRecording && (
            <div className="recording-indicator">
              <span className="recording-dot"></span>
              <span className="recording-time">{formatDuration(recordingDuration)}</span>
            </div>
          )}
          <div className="connection-status">
            <span className={`status-dot ${isRecording ? 'recording' : 'idle'}`}></span>
            <span className="status-text">{isRecording ? '录制中' : '就绪'}</span>
          </div>
        </div>
      </div>
    </header>
  );
};
export default Header
