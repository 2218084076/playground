# React Hero UI App

一个基于 React 和 Hero UI 的实时录制应用，支持通过 WebSocket 实时传输音频数据。

## 功能特性

- 🎙️ **实时音频录制** - 使用 MediaRecorder API 进行高质量音频录制
- 📡 **WebSocket 实时传输** - 实时将录制的音频数据发送到服务器
- 🎨 **现代化 UI** - 使用 Hero UI 组件库构建的美观界面
- 📊 **数据仪表盘** - 查看录制统计和历史记录
- ⚙️ **设置页面** - 配置 WebSocket 连接和音频参数
- 📱 **响应式设计** - 适配桌面和移动设备

## 页面路由

- `/` - 录制页面（主要功能）
- `/dashboard` - 数据仪表盘
- `/settings` - 设置页面
- `/about` - 关于页面

## 技术栈

- React 18
- TypeScript
- Vite
- Hero UI
- React Router
- Web Audio API
- WebSocket

## 开始使用

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

### 构建生产版本

```bash
npm run build
```

## WebSocket 服务端要求

应用需要一个 WebSocket 服务器来接收音频数据。默认连接地址是 `ws://localhost:8080/audio`。

服务器应支持：

- 接收二进制音频数据
- 处理 JSON 格式的状态消息

## 项目结构

```
src/
├── components/      # React 组件
│   └── Header/     # 头部导航组件
├── pages/          # 页面组件
│   ├── RecordingPage/   # 录制页面
│   ├── DashboardPage/   # 仪表盘页面
│   ├── SettingsPage/    # 设置页面
│   └── AboutPage/      # 关于页面
├── services/       # 服务层
│   ├── websocket.ts     # WebSocket 服务
│   └── recording.ts    # 录制服务
├── App.tsx        # 应用入口
├── main.tsx       # React 入口
└── index.css      # 全局样式
```

## 许可证

MIT License
