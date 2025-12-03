import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 提供靜態文件服務（Vite 構建後的 dist 目錄）
const distPath = path.join(__dirname, "../../dist");
app.use(express.static(distPath));

// ---- API START ----

app.get("/api/stores", (req, res) => {
  // 從 src/server/ 回到根目錄的 data 資料夾
  const filePath = path.join(__dirname, "../../data/taiwan_stores_data.json");

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading json file:", err);
      return res.status(500).json({ error: "Failed to read data file" });
    }

    try {
      const jsonData = JSON.parse(data);
      res.json(jsonData);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr);
      res.status(500).json({ error: "Invalid JSON format" });
    }
  });
});

// ---- API END ----

// 所有其他路由都返回 index.html（用於 React Router）
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// Render 會從這裡讀 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
