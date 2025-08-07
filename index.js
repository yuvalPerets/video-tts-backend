const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const googleTTS = require("google-tts-api");
const { v4: uuidv4 } = require("uuid");

// Set paths for ffmpeg and ffprobe
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;

const cors = require("cors");
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://video-tts-client.vercel.app"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Ensure required folders exist
["uploads", "subtitles", "assets", "output"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Periodic cleanup: Delete files older than 10 minutes every 5 minutes
setInterval(() => {
  const folders = ["uploads", "subtitles", "assets", "output"];
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes

  folders.forEach((folder) => {
    fs.readdir(folder, (err, files) => {
      if (err) return;
      files.forEach((file) => {
        const filePath = path.join(folder, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > maxAge) {
            fs.unlink(filePath, (err) => {
              if (!err) {
                console.log(`🧹 Deleted stale file: ${filePath}`);
              }
            });
          }
        });
      });
    });
  });
}, 5 * 60 * 1000); // Runs every 5 minutes


const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, uuidv4().replace(/-/g, "") + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Format time for .srt
const formatTime = (sec) => {
  const date = new Date(sec * 1000).toISOString().substr(11, 8);
  const ms = String(Math.floor((sec % 1) * 1000)).padStart(3, "0");
  return `${date},${ms}`;
};

// Get audio duration using ffprobe
const getAudioDuration = (filePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });

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

    // Generate TTS audio
    const audioBase64 = await googleTTS.getAudioBase64(cleanText, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });
    const audioPath = `assets/tts_${uuidv4().slice(0, 8)}.aac`;
    fs.writeFileSync(audioPath, Buffer.from(audioBase64, "base64"));

    // Generate subtitles line-by-line
    const srtPath = `subtitles/sub_${uuidv4().slice(0, 8)}.srt`;
    const words = cleanText.split(" ");
    const chunkSize = 6; // words per subtitle line
    const lines = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      lines.push(words.slice(i, i + chunkSize).join(" "));
    }

    const audioDuration = await getAudioDuration(audioPath);
    const buffer = 0.15;
    const lineDuration = Math.max((audioDuration / lines.length) - buffer, 0.5);

    let startTime = 0;
    const srtContent = lines.map((line, i) => {
      const endTime = startTime + lineDuration;
      const srtBlock = `${i + 1}\n${formatTime(startTime)} --> ${formatTime(endTime)}\n${line}\n`;
      startTime = endTime + buffer;
      return srtBlock;
    }).join("\n");

    fs.writeFileSync(srtPath, srtContent);

    const outputFilename = `final_${uuidv4().slice(0, 8)}.mp4`;
    const outputPath = path.join("output", outputFilename);

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .complexFilter([
        "[0:a]volume=0.3[a0]",       // Lower original video audio
        "[1:a]volume=1.0[a1]",       // Full TTS volume
        "[a0][a1]amix=inputs=2:duration=longest[a]", // Mix them
        `subtitles=${srtPath.replace(/\\/g, "/")}`   // Add subtitles
      ])
      .outputOptions([
        "-map 0:v:0",
        "-map [a]",
        "-c:v libx264",
        "-c:a aac",
        "-shortest"
      ])
      .on("start", (cmd) => console.log("🎬 FFmpeg started:", cmd))
      .on("end", () => {
        console.log("✅ FFmpeg finished. Starting file stream...");

        if (!fs.existsSync(outputPath)) {
          return res.status(500).json({ error: "Output video not found" });
        }

        const fileStat = fs.statSync(outputPath);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${outputFilename}"`,
          "Content-Length": fileStat.size,
        });
        res.flushHeaders();

        const fileStream = fs.createReadStream(outputPath);
        fileStream.pipe(res);

        fileStream.on("close", () => {
          console.log("📤 File stream completed");

          try {
            fs.unlinkSync(videoPath);
            fs.unlinkSync(audioPath);
            fs.unlinkSync(srtPath);
            fs.unlinkSync(outputPath);
          } catch (err) {
            console.warn("⚠️ Cleanup error:", err.message);
          }
        });

        fileStream.on("error", (err) => {
          console.error("❌ File stream error:", err.message);
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream video" });
          }
        });
      })
      .on("error", (err) => {
        console.error("❌ FFmpeg error:", err.message);
        if (!res.headersSent) {
          return res.status(500).json({ error: "Failed to create video" });
        }
      })
      .save(outputPath);

  } catch (err) {
    console.error("❌ Server Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Server failed" });
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);
});
