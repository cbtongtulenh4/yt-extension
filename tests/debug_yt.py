import yt_dlp
import os

def get_ffmpeg_path():
    # Giả lập logic trong server/yt_url.py nếu cần
    return None

url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
search_opts = {'quiet': True, 'no_warnings': True}

with yt_dlp.YoutubeDL(search_opts) as ydl:
    info = ydl.extract_info(url, download=False)
    formats = info.get('formats', [])
    available_heights = {f.get('height') for f in formats if f.get('vcodec') != 'none' and f.get('height') is not None}
    sorted_qualities = sorted(list(available_heights), reverse=True)
    
    print(f"Qualities: {sorted_qualities}")
    
    # Kiểm tra xem có 1080p không
    if 1080 in sorted_qualities:
        print("FOUND 1080p!")
    else:
        print("NO 1080p found. Available heights:")
        for f in formats:
            if f.get('height'):
                print(f"Height: {f.get('height')}, vcodec: {f.get('vcodec')}, format_id: {f.get('format_id')}")
