# 巡台神器

## Render 部署配置

在 Render.com 上部署时，请设置以下配置：

### Build Command
```
npm install && npm run build
```
或者使用：
```
npm run render:build
```

### Start Command
```
npm start
```
（或留空，因为 Procfile 已设置为 `web: npm start`）

### 说明
- 在 `npm start` 之前自动运行 `npm run build`，作为双重保障
- 确保在 Build Command 中先安装依赖并构建前端
- 服务器启动时会自动提供 `dist` 目录中的静态文件