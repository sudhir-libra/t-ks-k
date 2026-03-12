#!/usr/bin/env python3
"""
Local Streaming Bridge - Receives from browser, pushes to YouTube RTMP

Usage:
1. Install Python dependencies: pip install flask opencv-python ffmpeg-python
2. Run: python streaming-bridge.py
3. In app: Use endpoint http://localhost:8889/stream
4. Configure YouTube Stream Key below
"""

import os
import sys
import subprocess
import threading
import time
import io
from flask import Flask, request, Response
import numpy as np
import cv2

# ============= CONFIGURATION =============
YOUTUBE_STREAM_KEY = ""  # Add your YouTube stream key here
# Full RTMP URL: rtmp://a.rtmp.youtube.com/live2/YOUR_KEY
# =========================================

app = Flask(__name__)

# Global frame buffer for FFmpeg
frame_buffer = None
frame_lock = threading.Lock()
stream_active = False
ffmpeg_process = None

def get_youtube_url():
    """Get YouTube RTMP URL with stream key"""
    if not YOUTUBE_STREAM_KEY:
        return None
    return f"rtmp://a.rtmp.youtube.com/live2/{YOUTUBE_STREAM_KEY}"

def start_ffmpeg_stream():
    """Start FFmpeg process to receive frames and stream to YouTube"""
    global ffmpeg_process
    
    youtube_url = get_youtube_url()
    if not youtube_url:
        print("[ERROR] YouTube stream key not configured!")
        print("Please edit streaming-bridge.py and set YOUTUBE_STREAM_KEY")
        return False
    
    print(f"[FFmpeg] Starting stream to: {youtube_url}")
    
    # FFmpeg command - reads from pipe, outputs to RTMP
    ffmpeg_cmd = [
        'ffmpeg',
        '-re',                          # Read at native frame rate
        '-f', 'rawvideo',               # Input format
        '-vcodec', 'rawvideo',          # Raw video codec
        '-s', '1280x720',               # Input resolution
        '-r', '30',                     # Input framerate
        '-pix_fmt', 'bgr24',            # Pixel format
        '-i', '-',                      # Read from stdin
        '-c:v', 'libx264',              # H.264 encoding
        '-preset', 'veryfast',          # Fast encoding
        '-tune', 'zerolatency',         # Low latency
        '-b:v', '4500k',                # Video bitrate
        '-maxrate', '6000k',            # Max bitrate
        '-bufsize', '9000k',            # Buffer size
        '-c:a', 'aac',                  # Audio codec
        '-b:a', '128k',                 # Audio bitrate
        '-ar', '48000',                 # Audio sample rate
        '-f', 'flv',                    # Output format
        youtube_url                     # YouTube RTMP URL
    ]
    
    try:
        ffmpeg_process = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0
        )
        print("[FFmpeg] Process started successfully")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to start FFmpeg: {e}")
        return False

def stop_ffmpeg_stream():
    """Stop FFmpeg process"""
    global ffmpeg_process
    if ffmpeg_process:
        print("[FFmpeg] Stopping stream...")
        ffmpeg_process.stdin.close()
        ffmpeg_process.terminate()
        ffmpeg_process = None

def send_frame_to_ffmpeg(frame):
    """Send a frame to FFmpeg stdin"""
    global ffmpeg_process
    if ffmpeg_process and ffmpeg_process.stdin:
        try:
            ffmpeg_process.stdin.write(frame.tobytes())
        except Exception as e:
            print(f"[ERROR] Failed to send frame: {e}")
            stop_ffmpeg_stream()

@app.route('/stream', methods=['POST'])
def receive_stream():
    """Receive stream from browser using multipart form data"""
    global stream_active, frame_buffer
    
    if not stream_active:
        # Start FFmpeg when first frame arrives
        if not start_ffmpeg_stream():
            return "Stream not configured", 500
        stream_active = True
    
    # Get frame from request
    if 'frame' not in request.files:
        # Try getting raw image data
        img_data = request.get_data()
        if img_data:
            # Decode image
            nparr = np.frombuffer(img_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is not None:
                send_frame_to_ffmpeg(frame)
    
    return "OK", 200

@app.route('/status', methods=['GET'])
def get_status():
    """Get streaming status"""
    return {
        "active": stream_active,
        "youtube_configured": bool(YOUTUBE_STREAM_KEY),
        "ffmpeg_running": ffmpeg_process is not None
    }

@app.route('/stop', methods=['POST'])
def stop_stream():
    """Stop the stream"""
    global stream_active
    stop_ffmpeg_stream()
    stream_active = False
    return "OK", 200

def main():
    print("=" * 50)
    print("  Local Streaming Bridge")
    print("=" * 50)
    print(f"Stream endpoint: http://localhost:8889/stream")
    print(f"Status endpoint: http://localhost:8889/status")
    print(f"Stop endpoint: http://localhost:8889/stop")
    print("")
    
    if not YOUTUBE_STREAM_KEY:
        print("WARNING: YouTube stream key not configured!")
        print("Edit streaming-bridge.py and set YOUTUBE_STREAM_KEY")
        print("")
    
    print("In the streaming app:")
    print("1. Set Protocol to 'WHIP (WebRTC)'")
    print("2. Use custom endpoint: http://localhost:8889/stream")
    print("3. Click Start Stream")
    print("")
    print("Press Ctrl+C to stop")
    
    # Note: This simple version doesn't actually receive WebRTC
    # For full WebRTC support, you'd need a proper WHIP server
    # This is a placeholder showing the architecture
    
    app.run(host='0.0.0.0', port=8889, debug=False)

if __name__ == '__main__':
    main()

