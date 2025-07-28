const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const googleTTS = require("google-tts-api");
const { v4: uuidv4 } = require("uuid");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Ensure required folders exist
["uploads", "subtitles", "assets", "output"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, uuidv4().replace(/-/g, "") + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Format time for SRT
const formatTime = (sec) => {
  const date = new Date(sec * 1000).toISOString().substr(11, 8);
  const ms = String(Math.floor((sec % 1) * 1000)).padStart(3, "0");
  return `${date},${ms}`;
};

// Upload endpoint
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const videoPath = req.file?.path;
    const inputText = req.body?.text;

    if (!inputText || !videoPath) {
      return res.status(400).json({ error: "Missing video or text input" });
    }

    const cleanText = inputText
      .normalize("NFKC")
      .replace(/[^\w\s.,!?'"()-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // TTS audio generation
    const audioBase64 = await googleTTS.getAudioBase64(cleanText, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });
    const audioPath = `assets/tts_${uuidv4().slice(0, 8)}.aac`;
    fs.writeFileSync(audioPath, Buffer.from(audioBase64, "base64"));

    // Subtitle generation
    const srtPath = `subtitles/sub_${uuidv4().slice(0, 8)}.srt`;
    const words = cleanText.split(" ");
    const wordDuration = 0.5;
    let startTime = 0;
    const srtContent = words
      .map((word, i) => {
        const endTime = startTime + wordDuration;
        const srtBlock = `${i + 1}
${formatTime(startTime)} --> ${formatTime(endTime)}
${word}\n`;
        startTime = endTime;
        return srtBlock;
      })
      .join("\n");
    fs.writeFileSync(srtPath, srtContent);

    // Output file path
    const outputFilename = `final_${uuidv4().slice(0, 8)}.mp4`;
    const outputPath = path.join("output", outputFilename);

    // Merge with FFmpeg
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(`subtitles=${srtPath.replace(/\\/g, "/")}`)
      .outputOption("-map", "0:v:0")
      .outputOption("-map", "1:a:0")
      .outputOption("-c:v", "libx264")
      .outputOption("-c:a", "aac")
      .outputOption("-shortest")
      .on("start", (cmd) => console.log("🎬 FFmpeg started:", cmd))
      .on("end", () => {
        console.log("✅ Done: Video created at", outputPath);
        res.json({ message: "Video created", file: outputFilename });

        // Cleanup temp files
        try {
          fs.unlinkSync(videoPath);
          fs.unlinkSync(audioPath);
          fs.unlinkSync(srtPath);
        } catch (err) {
          console.warn("⚠️ Cleanup error:", err.message);
        }
      })
      .on("error", (err) => {
        console.error("❌ FFmpeg error:", err.message);
        return res.status(500).json({ error: "Failed to create video" });
      })
      .save(outputPath);
  } catch (err) {
    console.error("❌ Server Error:", err);
    return res.status(500).json({ error: "Server failed" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);
});
