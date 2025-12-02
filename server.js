const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ---- API START ----

app.get("/", (req, res) => {
  res.send("API is running on Render!");
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello from Render Node.js API!" });
});

app.post("/add", (req, res) => {
  const { name } = req.body;
  res.json({
    success: true,
    received: name
  });
});

// ---- API END ----

// Render 會從這裡讀 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
