const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

// Proper Node <18 fetch
const fetch = require("node-fetch"); // <- must install node-fetch@2

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: ["http://localhost:3000","https://video-tts-client.vercel.app"],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure folders exist
["uploads","assets","subtitles","output"].forEach(dir => { if(!fs.existsSync(dir)) fs.mkdirSync(dir); });

// Multer setup
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null,"uploads/"),
  filename: (req,file,cb) => cb(null, uuidv4().replace(/-/g,"") + path.extname(file.originalname))
});
const upload = multer({ storage });

// Memory logging
const logMemory = (step) => {
  const mem = process.memoryUsage();
  console.log(`[Memory] ${step}: RSS=${(mem.rss/1024/1024).toFixed(2)}MB HeapUsed=${(mem.heapUsed/1024/1024).toFixed(2)}MB`);
};

// Format SRT time
const formatTime = (sec) => {
  const date = new Date(sec*1000).toISOString().substr(11,8);
  const ms = String(Math.floor((sec%1)*1000)).padStart(3,"0");
  return `${date},${ms}`;
};

// Get audio duration
const getAudioDuration = (filePath) => new Promise((resolve,reject) => {
  ffmpeg.ffprobe(filePath,(err,meta)=>{ if(err) reject(err); else resolve(meta.format.duration); });
});

// Generate SRT from text and audio duration
const generateSrt = (text, duration, chunkSize=6) => {
  const words = text.replace(/[^\w\s.,!?'"()-]/g,"").split(" ");
  const lines = [];
  for(let i=0;i<words.length;i+=chunkSize) lines.push(words.slice(i,i+chunkSize).join(" "));
  const buffer = 0.15;
  const lineDuration = Math.max((duration/lines.length)-buffer,0.5);
  let startTime = 0;
  const srtContent = lines.map((line,i)=>{
    const endTime = startTime + lineDuration;
    const block = `${i+1}\n${formatTime(startTime)} --> ${formatTime(endTime)}\n${line}\n`;
    startTime = endTime + buffer;
    return block;
  }).join("\n");
  return srtContent;
};

// Upload endpoint
app.post("/upload", upload.single("video"), async (req,res)=>{
  try{
    const videoFile = req.file;
    const text = req.body?.text;
    if(!videoFile || !text) return res.status(400).json({error:"Missing video or text"});

    logMemory("After upload");

    // Stage 1: Convert/downscale video to 480p MP4
    const convertedPath = `uploads/converted_${uuidv4().slice(0,8)}.mp4`;
    await new Promise((resolve,reject)=>{
      ffmpeg(videoFile.path)
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-movflags +faststart",
          "-vf scale=854:-2",
          "-crf 28",
          "-preset veryfast"
        ])
        .on("end", resolve)
        .on("error", reject)
        .save(convertedPath);
    });
    fs.unlinkSync(videoFile.path);
    logMemory("After convert/downscale");

    // Stage 2: Generate TTS audio -> stream to file
    const audioPath = `assets/tts_${uuidv4().slice(0,8)}.mp3`;
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
    const response = await fetch(ttsUrl);
    await new Promise((resolve,reject)=>{
      const fileStream = fs.createWriteStream(audioPath);
      response.body.pipe(fileStream);
      response.body.on("error", reject);
      fileStream.on("finish", resolve);
    });
    logMemory("After TTS");

    // Stage 3: Get audio duration and generate subtitles
    const audioDuration = await getAudioDuration(audioPath);
    const srtPath = `subtitles/sub_${uuidv4().slice(0,8)}.srt`;
    const srtContent = generateSrt(text, audioDuration);
    fs.writeFileSync(srtPath, srtContent);
    logMemory("After SRT generation");

    // Stage 4: Mix audio and burn subtitles
    const outputFilename = `final_${uuidv4().slice(0,8)}.mp4`;
    const outputPath = path.join("output",outputFilename);

    await new Promise((resolve,reject)=>{
      ffmpeg()
        .input(convertedPath)
        .input(audioPath)
        .complexFilter([
          "[0:a]volume=0.3[a0]",
          "[1:a]volume=1.0[a1]",
          "[a0][a1]amix=inputs=2:duration=longest[a]",
          `subtitles=${srtPath.replace(/\\/g,"/")}`
        ])
        .outputOptions([
          "-map 0:v:0",
          "-map [a]",
          "-c:v libx264",
          "-c:a aac",
          "-shortest"
        ])
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });
    logMemory("After audio mix + subtitles");

    // Cleanup
    fs.unlinkSync(convertedPath);
    fs.unlinkSync(audioPath);
    fs.unlinkSync(srtPath);

    // Stream final file
    const fileStat = fs.statSync(outputPath);
    res.writeHead(200,{
      "Content-Type":"video/mp4",
      "Content-Disposition": `attachment; filename="${outputFilename}"`,
      "Content-Length": fileStat.size
    });
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on("close", ()=> fs.unlinkSync(outputPath));

  } catch(err){
    console.error("Server error:",err);
    if(!res.headersSent) res.status(500).json({error:"Processing failed"});
  }
});

app.get("/health",(req,res)=>res.json({status:"OK",timestamp:new Date().toISOString()}));

app.listen(port,()=>console.log(`🚀 Server running at http://localhost:${port}`));
