import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { TranscriptionPage } from './pages/TranscriptionPage';

const App: React.FC = () => {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/transcribe" element={<TranscriptionPage />} />
      </Routes>
    </div>
  );
};

export default App;
