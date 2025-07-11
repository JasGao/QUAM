from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yt_dlp
import whisper
import os
import uuid
import threading

app = FastAPI()

# Allow CORS for all origins (for development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development, allows all origins. For production, use your frontend URL.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str

# In-memory job store (for demo; use Redis or DB for production)
jobs = {}

def transcribe_job(job_id, url):
    print(f"Starting job {job_id} for URL: {url}")
    audio_filename = f"audio_{uuid.uuid4()}.mp3"
    try:
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': audio_filename,
            'quiet': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        print(f"Downloaded audio to {audio_filename}")
        model = whisper.load_model("small")
        print(f"Loaded Whisper model")
        result = model.transcribe(audio_filename)
        transcript = result["text"]
        jobs[job_id] = {"status": "done", "transcript": transcript}
        print(f"Job {job_id} done")
    except Exception as e:
        jobs[job_id] = {"status": "error", "error": str(e)}
        print(f"Job {job_id} error: {e}")
    finally:
        if os.path.exists(audio_filename):
            os.remove(audio_filename)
            print(f"Cleaned up {audio_filename}")

@app.post("/transcribe-job")
async def start_transcription(req: VideoRequest):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "processing"}
    threading.Thread(target=transcribe_job, args=(job_id, req.url), daemon=True).start()
    return {"job_id": job_id}

@app.get("/transcribe-job/{job_id}")
async def get_transcription(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job 