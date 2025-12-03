const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ---- API START ----

app.get("/", (req, res) => {
  res.send("API is running on Render!");
});

app.get("/api/stores", (req, res) => {
  const filePath = path.join(__dirname, "data", "taiwan_stores_data.json");

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

// Render 會從這裡讀 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
