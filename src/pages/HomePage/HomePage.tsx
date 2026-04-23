import React from 'react';
import { Link } from 'react-router-dom';
import './HomePage.css';

export const HomePage: React.FC = () => {
  return (
    <div className="home-page">
      <div className="home-container">
        <h1 className="home-title">音频工具集</h1>
        <p className="home-subtitle">选择功能开始使用</p>

        <div className="feature-cards">
          <Link to="/transcribe" className="feature-card">
            <div className="card-icon">🎤</div>
            <h2>语音转文字</h2>
            <p>上传音频文件或使用麦克风进行实时语音转文字</p>
          </Link>
        </div>
      </div>
    </div>
  );
};
